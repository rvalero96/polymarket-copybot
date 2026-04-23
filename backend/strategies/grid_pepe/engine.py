import asyncio
import datetime
import json
import time

import websockets

from config import CONFIG
from db.connection import get_db, fetchall, fetchone
from logger import logger
from services.binance import fetch_spot_price, fetch_candles


# ── Moving Average Helpers (pure functions) ────────────────────────────────────

def _ema_series(closes: list[float], period: int) -> list[float]:
    """Return a list of EMA values — one per close after the initial seed."""
    if len(closes) < period:
        return []
    k = 2 / (period + 1)
    result = [sum(closes[:period]) / period]
    for c in closes[period:]:
        result.append(c * k + result[-1] * (1 - k))
    return result


def _sma(closes: list[float], period: int) -> float:
    return sum(closes[-period:]) / period


def _ema(closes: list[float], period: int) -> float:
    series = _ema_series(closes, period)
    return series[-1] if series else sum(closes[-period:]) / period


def _vwma(candles: list[dict], period: int) -> float:
    window = candles[-period:]
    total_vol = sum(c["volume"] for c in window)
    if total_vol == 0:
        return _sma([c["close"] for c in window], period)
    return sum(c["close"] * c["volume"] for c in window) / total_vol


def _tema(closes: list[float], period: int) -> float:
    e1 = _ema_series(closes, period)
    if not e1:
        return closes[-1]
    e2 = _ema_series(e1, period)
    if not e2:
        return e1[-1]
    e3 = _ema_series(e2, period)
    if not e3:
        return e2[-1]
    return 3 * e1[-1] - 3 * e2[-1] + e3[-1]


def _lreg(closes: list[float], period: int) -> float:
    window = closes[-period:]
    n = len(window)
    x_mean = (n - 1) / 2
    y_mean = sum(window) / n
    num = sum((i - x_mean) * (y - y_mean) for i, y in enumerate(window))
    den = sum((i - x_mean) ** 2 for i in range(n))
    if den == 0:
        return y_mean
    slope = num / den
    intercept = y_mean - slope * x_mean
    return intercept + slope * (n - 1)


# ── Engine ─────────────────────────────────────────────────────────────────────

class AdaptiveGridPepeEngine:
    def __init__(self):
        self._task: asyncio.Task | None = None
        self._candle_task: asyncio.Task | None = None
        self._price: float | None = None
        self._prev_price: float | None = None
        self._price_history: list[dict] = []
        self._max_history = 600
        self.running = False
        self._config_id: int | None = None

        # Adaptive grid state
        self._anchor: float | None = None
        self._gi: float | None = None
        self._grid_levels: list[float] = []   # 9 levels G0..G8
        self._grid_epoch: int = 0

        # Order state
        self._pending: dict[int, dict] = {}
        self._bought: dict[int, dict] = {}

        # Fill detection throttle
        self._last_check = 0.0
        self._check_interval = 0.15

        # Cooldown per level_index (monotonic time)
        self._cooldown_until: dict[int, float] = {}

        # Last anchor reset timestamp (ms)
        self._last_reset_at: int | None = None

        # Candle / MA state
        self._candles: list[dict] = []
        self._ma_value: float | None = None
        self._ma_type:      str   = CONFIG.pepe_grid_ma_type
        self._ma_period:    int   = CONFIG.pepe_grid_ma_period
        self._order_size:   float = CONFIG.pepe_grid_order_size
        self._interval_pct: float = CONFIG.pepe_grid_interval_pct
        self._laziness_pct: float = CONFIG.pepe_grid_laziness_pct

        # SSE pub/sub
        self._subscribers: list[asyncio.Queue] = []

        # Mutex: prevents concurrent start() calls racing through the running=False window
        self._start_lock: asyncio.Lock = asyncio.Lock()

    # ── Pub/sub ────────────────────────────────────────────────────────────────

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=20)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def _broadcast(self) -> None:
        if not self._subscribers:
            return
        data = json.dumps(await self.get_status())
        dead = []
        for q in self._subscribers:
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self.unsubscribe(q)

    # ── Bankroll helpers ────────────────────────────────────────────────────────

    async def _get_bankroll(self, db) -> float:
        snap = await fetchone(db, "SELECT bankroll FROM snapshots ORDER BY date DESC LIMIT 1")
        return (snap or {}).get("bankroll") or CONFIG.paper_bankroll

    async def _update_bankroll(self, db, bankroll: float) -> None:
        today = datetime.date.today().isoformat()
        now_ms = int(time.time() * 1000)
        await db.execute("""
            INSERT INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
            VALUES (?, ?, 0, ?, 0, NULL, ?)
            ON CONFLICT(date) DO UPDATE SET
                bankroll   = excluded.bankroll,
                pnl_total  = excluded.pnl_total,
                created_at = excluded.created_at
        """, (today, bankroll, bankroll - CONFIG.paper_bankroll, now_ms))

    # ── MA / grid construction ──────────────────────────────────────────────────

    def _compute_ma(self, ma_type: str | None = None, period: int | None = None) -> float | None:
        period  = period  or CONFIG.pepe_grid_ma_period
        ma_type = (ma_type or CONFIG.pepe_grid_ma_type).upper()
        if len(self._candles) < period:
            return None
        closes = [c["close"] for c in self._candles]
        if ma_type == "SMA":
            return _sma(closes, period)
        if ma_type == "EMA":
            return _ema(closes, period)
        if ma_type == "VWMA":
            return _vwma(self._candles, period)
        if ma_type == "TEMA":
            return _tema(closes, period)
        if ma_type == "LREG":
            return _lreg(closes, period)
        return _ema(closes, period)

    def _build_grid_levels(self, ap: float) -> list[float]:
        """Return 9 price levels G0..G8. G0 = AP+4*GI (top), G4 = AP, G8 = AP-4*GI (bottom)."""
        gi = ap * self._interval_pct
        return [ap + (4 - i) * gi for i in range(9)]

    def _should_update_anchor(self, price: float) -> bool:
        if self._anchor is None:
            return True
        deviation = abs(price - self._anchor) / self._anchor
        return deviation > self._laziness_pct

    async def _maybe_update_anchor(self, price: float) -> bool:
        """Returns True if anchor was updated (signals a grid reset is needed)."""
        if not self._should_update_anchor(price):
            return False
        ma = self._compute_ma(self._ma_type, self._ma_period)
        if ma is None:
            return False
        self._anchor = ma
        self._gi = ma * self._interval_pct
        self._grid_levels = self._build_grid_levels(ma)
        self._ma_value = ma
        self._grid_epoch += 1
        self._last_reset_at = int(time.time() * 1000)
        logger.info("pepe_grid:anchor:updated", {
            "ap": ma, "gi": self._gi, "epoch": self._grid_epoch
        })
        asyncio.create_task(self._persist_anchor(ma))
        return True

    async def _persist_anchor(self, ap: float) -> None:
        db = await get_db()
        gi = ap * self._interval_pct
        now_ms = int(time.time() * 1000)
        await db.execute(
            "UPDATE pepe_grid_config SET anchor_price=?, grid_interval=?, updated_at=? WHERE id=?",
            (ap, gi, now_ms, self._config_id)
        )
        await db.commit()

    # ── Grid reset ──────────────────────────────────────────────────────────────

    async def _handle_grid_reset(self, db) -> None:
        if not self._grid_levels:
            return

        grid_min = self._grid_levels[-1]   # G8 = bottom
        grid_max = self._grid_levels[0]    # G0 = top

        # Cancel pending orders outside the new grid range
        to_cancel = [
            oid for oid, o in self._pending.items()
            if o["buy_price"] < grid_min or o["buy_price"] > grid_max
        ]
        for oid in to_cancel:
            del self._pending[oid]
            await db.execute(
                "UPDATE pepe_grid_orders SET status='cancelled' WHERE id=?", (oid,)
            )

        # Which level indices are already covered (pending or bought)?
        covered = (
            {o["level_index"] for o in self._pending.values()} |
            {o["level_index"] for o in self._bought.values()}
        )

        levels = self._grid_levels
        order_size = self._order_size
        for i in range(1, 9):
            buy_price  = levels[i]
            sell_price = levels[i - 1]
            level_idx  = 4 - i   # i=1 → +3, i=4 → 0, i=8 → -4
            if level_idx in covered:
                continue
            async with db.execute(
                """INSERT INTO pepe_grid_orders
                   (config_id, grid_epoch, level_index, buy_price, sell_price, order_size, status)
                   VALUES (?,?,?,?,?,?,'pending')""",
                (self._config_id, self._grid_epoch, level_idx, buy_price, sell_price, order_size)
            ) as cur:
                new_id = cur.lastrowid
            self._pending[new_id] = {
                "id": new_id, "config_id": self._config_id,
                "grid_epoch": self._grid_epoch, "level_index": level_idx,
                "buy_price": buy_price, "sell_price": sell_price, "order_size": order_size,
            }

        await db.commit()
        logger.info("pepe_grid:reset", {
            "epoch": self._grid_epoch,
            "cancelled": len(to_cancel),
            "pending": len(self._pending),
        })

    # ── Fill detection ──────────────────────────────────────────────────────────

    async def _check_fills(self, price: float, ts_ms: int) -> None:
        now_mono = time.monotonic()
        if now_mono - self._last_check < self._check_interval:
            return
        self._last_check = now_mono

        # Check anchor update and trigger reset if needed
        anchor_changed = await self._maybe_update_anchor(price)
        db = await get_db()
        if anchor_changed:
            await self._handle_grid_reset(db)

        # Stop-loss: if unrealized PnL < -stop_loss_pct of deployed capital, stop the grid
        if self._bought:
            deployed = sum(o["order_size"] for o in self._bought.values())
            unrealized = sum(
                (o["order_size"] / o["buy_fill_price"]) * (price - o["buy_fill_price"])
                - o["order_size"] * CONFIG.pepe_grid_fee_pct * 2
                for o in self._bought.values()
                if o.get("buy_fill_price")
            )
            if deployed > 0 and (unrealized / deployed) < -CONFIG.pepe_grid_stop_loss_pct:
                logger.warning("pepe_grid:stop_loss:triggered", {
                    "unrealized_pnl": round(unrealized, 6),
                    "deployed": round(deployed, 4),
                    "drawdown_pct": round(unrealized / deployed * 100, 2),
                })
                asyncio.create_task(self.stop())
                return

        to_buy = [
            (oid, o) for oid, o in list(self._pending.items())
            if price <= o["buy_price"]
            and now_mono >= self._cooldown_until.get(o["level_index"], 0)
        ]
        to_sell = [
            (oid, o) for oid, o in list(self._bought.items())
            if price >= o["sell_price"]
        ]

        if not to_buy and not to_sell:
            return

        bankroll = await self._get_bankroll(db)
        bankroll_changed = False

        for oid, order in to_buy:
            if bankroll < order["order_size"]:
                logger.warn("pepe_grid:buy:skipped_no_funds", {
                    "level_index": order["level_index"],
                    "need": order["order_size"],
                    "have": round(bankroll, 4),
                })
                continue
            bankroll -= order["order_size"]
            bankroll_changed = True
            order["buy_fill_price"] = price
            order["bought_at"] = ts_ms
            self._bought[oid] = order
            del self._pending[oid]
            self._cooldown_until[order["level_index"]] = now_mono + CONFIG.pepe_grid_cooldown_s
            await db.execute(
                "UPDATE pepe_grid_orders SET status='bought', bought_at=?, buy_fill_price=? WHERE id=?",
                (ts_ms, price, oid)
            )
            logger.info("pepe_grid:buy:filled", {
                "level_index": order["level_index"],
                "price": price,
                "bankroll_left": round(bankroll, 4),
            })

        for oid, order in to_sell:
            fee = order["order_size"] * CONFIG.pepe_grid_fee_pct * 2
            units = order["order_size"] / order["buy_fill_price"]
            pnl = round(units * (price - order["buy_fill_price"]) - fee, 10)
            bankroll += order["order_size"] + pnl
            bankroll_changed = True

            await db.execute(
                "UPDATE pepe_grid_orders SET status='closed', sold_at=?, sell_fill_price=? WHERE id=?",
                (ts_ms, price, oid)
            )
            await db.execute(
                """INSERT INTO pepe_grid_trades
                   (order_id, level_index, grid_epoch, buy_price, sell_price, order_size_usd,
                    pnl, fee, anchor_at_trade, opened_at, closed_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (oid, order["level_index"], order["grid_epoch"],
                 order["buy_fill_price"], price, order["order_size"],
                 pnl, round(fee, 10), self._anchor, order["bought_at"], ts_ms)
            )

            # Re-create pending order at same level if still within grid range
            grid_min = self._grid_levels[-1] if self._grid_levels else 0
            grid_max = self._grid_levels[0]  if self._grid_levels else float("inf")
            del self._bought[oid]

            if grid_min <= order["buy_price"] <= grid_max:
                async with db.execute(
                    """INSERT INTO pepe_grid_orders
                       (config_id, grid_epoch, level_index, buy_price, sell_price, order_size, status)
                       VALUES (?,?,?,?,?,?,'pending')""",
                    (self._config_id, self._grid_epoch, order["level_index"],
                     order["buy_price"], order["sell_price"], order["order_size"])
                ) as cur:
                    new_id = cur.lastrowid
                self._pending[new_id] = {
                    "id": new_id, "config_id": self._config_id,
                    "grid_epoch": self._grid_epoch,
                    "level_index": order["level_index"],
                    "buy_price": order["buy_price"],
                    "sell_price": order["sell_price"],
                    "order_size": order["order_size"],
                }

            logger.info("pepe_grid:sell:filled", {
                "level_index": order["level_index"],
                "price": price,
                "pnl": pnl,
                "bankroll": round(bankroll, 4),
            })

        if bankroll_changed:
            await self._update_bankroll(db, bankroll)
        await db.commit()
        asyncio.create_task(self._broadcast())

    # ── WebSocket loop ──────────────────────────────────────────────────────────

    async def _ws_loop(self) -> None:
        backoff = 1.0
        while self.running:
            try:
                async with websockets.connect(CONFIG.pepe_grid_ws_url, ping_interval=20) as ws:
                    logger.info("pepe_grid:ws:connected")
                    backoff = 1.0  # reset on successful connect
                    async for raw in ws:
                        if not self.running:
                            break
                        msg   = json.loads(raw)
                        price = float(msg["p"])
                        ts_ms = int(msg["T"])
                        ts_s  = ts_ms // 1000
                        if self._prev_price is None:
                            self._prev_price = price
                        self._price = price
                        if not self._price_history or self._price_history[-1]["time"] != ts_s:
                            self._price_history.append({"time": ts_s, "value": price})
                            if len(self._price_history) > self._max_history:
                                self._price_history.pop(0)
                        await self._check_fills(price, ts_ms)
                        self._prev_price = price
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("pepe_grid:ws:error", {"error": str(exc), "retry_in": backoff})
                if self.running:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)  # cap at 60s

    # ── Candle refresh loop ─────────────────────────────────────────────────────

    async def _candle_refresh_loop(self) -> None:
        while self.running:
            try:
                period = self._ma_period
                candles = await fetch_candles(
                    "PEPEUSDT", CONFIG.pepe_grid_candle_tf, max(period * 5, 200)
                )
                if candles and len(candles) >= period:
                    self._candles = candles
                    self._ma_value = self._compute_ma(self._ma_type, self._ma_period)
            except Exception as exc:
                logger.error("pepe_grid:candle_refresh:error", {"error": str(exc)})
            await asyncio.sleep(60)

    # ── Public API ──────────────────────────────────────────────────────────────

    async def start(
        self,
        order_size: float,
        ma_type: str,
        ma_period: int,
        interval_pct: float,
        laziness_pct: float,
    ) -> dict:
        if self._start_lock.locked():
            return {"ok": False, "error": "PEPE grid start already in progress"}

        async with self._start_lock:
            return await self._start_inner(order_size, ma_type, ma_period, interval_pct, laziness_pct)

    async def _start_inner(
        self,
        order_size: float,
        ma_type: str,
        ma_period: int,
        interval_pct: float,
        laziness_pct: float,
    ) -> dict:
        # Refuse only if tasks are genuinely alive
        task_alive   = self._task        and not self._task.done()
        candle_alive = self._candle_task and not self._candle_task.done()
        if self.running and (task_alive or candle_alive):
            return {"ok": False, "error": "PEPE grid already running"}

        # Any stale state (dead tasks, leftover config_id) — force-stop first for clean slate
        if self.running or self._config_id:
            logger.warning("pepe_grid:start:force_stop", "Clearing stale state before start")
            await self.stop()

        # Fetch initial candles and compute first MA
        try:
            candles = await fetch_candles("PEPEUSDT", CONFIG.pepe_grid_candle_tf, max(ma_period * 5, 200))
        except Exception as exc:
            return {"ok": False, "error": f"Failed to fetch candles: {exc}"}

        if len(candles) < ma_period:
            return {"ok": False, "error": "Insufficient candle data to compute MA"}

        self._candles = candles
        ma = self._compute_ma(ma_type=ma_type, period=ma_period)

        if ma is None:
            return {"ok": False, "error": "Could not compute MA from candle data"}

        try:
            ref_price = await fetch_spot_price("PEPEUSDT")
        except Exception:
            ref_price = ma

        db = await get_db()
        now_ms = int(time.time() * 1000)
        await db.execute(
            "UPDATE pepe_grid_config SET status='stopped', updated_at=? WHERE status='running'",
            (now_ms,)
        )

        gi = ma * interval_pct
        async with db.execute(
            """INSERT INTO pepe_grid_config
               (order_size, ma_type, ma_period, interval_pct, laziness_pct, candle_tf,
                anchor_price, grid_interval, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,'running',?,?)""",
            (order_size, ma_type, ma_period, interval_pct, laziness_pct,
             CONFIG.pepe_grid_candle_tf, ma, gi, now_ms, now_ms)
        ) as cur:
            self._config_id = cur.lastrowid

        # Set engine state
        self._anchor = ma
        self._gi = gi
        self._ma_value = ma
        self._ma_type      = ma_type
        self._ma_period    = ma_period
        self._order_size   = order_size
        self._interval_pct = interval_pct
        self._laziness_pct = laziness_pct
        self._grid_epoch   = 1
        self._last_reset_at = int(time.time() * 1000)
        self._grid_levels = self._build_grid_levels(ma)
        self._pending.clear()
        self._bought.clear()
        self._cooldown_until.clear()

        # Create all 8 buy-level pending orders (no pre-buying)
        levels = self._grid_levels
        for i in range(1, 9):
            buy_price  = levels[i]
            sell_price = levels[i - 1]
            level_idx  = 4 - i
            async with db.execute(
                """INSERT INTO pepe_grid_orders
                   (config_id, grid_epoch, level_index, buy_price, sell_price, order_size, status)
                   VALUES (?,?,?,?,?,?,'pending')""",
                (self._config_id, self._grid_epoch, level_idx,
                 buy_price, sell_price, order_size)
            ) as cur:
                oid = cur.lastrowid
            self._pending[oid] = {
                "id": oid, "config_id": self._config_id,
                "grid_epoch": self._grid_epoch, "level_index": level_idx,
                "buy_price": buy_price, "sell_price": sell_price, "order_size": order_size,
            }

        await db.commit()
        self.running = True
        self._task = asyncio.create_task(self._ws_loop())
        self._candle_task = asyncio.create_task(self._candle_refresh_loop())

        # Detect silent task death (unhandled exception) → full stop for clean DB state
        def _on_task_done(task: asyncio.Task) -> None:
            if not self.running:
                return
            if not task.cancelled() and task.exception() is not None:
                logger.error("pepe_grid:task:died", {"error": str(task.exception())})
                asyncio.create_task(self.stop())

        self._task.add_done_callback(_on_task_done)
        self._candle_task.add_done_callback(_on_task_done)

        logger.info("pepe_grid:started", {
            "config_id": self._config_id, "ap": ma, "gi": gi,
            "ref_price": ref_price, "levels": len(self._pending),
        })
        asyncio.create_task(self._broadcast())
        return {
            "ok": True,
            "config_id": self._config_id,
            "anchor": ma,
            "grid_interval": gi,
            "grid_levels": self._grid_levels,
            "ref_price": ref_price,
        }

    async def stop(self) -> None:
        """Fully idempotent: always cancels tasks and updates DB regardless of running state."""
        self.running = False

        for t in [self._task, self._candle_task]:
            if t:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
        self._task = self._candle_task = None

        sell_price = self._price
        db = await get_db()
        ts_ms = int(time.time() * 1000)

        if sell_price and self._bought:
            bankroll = await self._get_bankroll(db)
            for oid, order in list(self._bought.items()):
                fee = order["order_size"] * CONFIG.pepe_grid_fee_pct * 2
                units = order["order_size"] / order["buy_fill_price"]
                pnl = round(units * (sell_price - order["buy_fill_price"]) - fee, 10)
                bankroll += order["order_size"] + pnl
                await db.execute(
                    "UPDATE pepe_grid_orders SET status='closed', sold_at=?, sell_fill_price=? WHERE id=?",
                    (ts_ms, sell_price, oid)
                )
                await db.execute(
                    """INSERT INTO pepe_grid_trades
                       (order_id, level_index, grid_epoch, buy_price, sell_price, order_size_usd,
                        pnl, fee, anchor_at_trade, close_reason, opened_at, closed_at)
                       VALUES (?,?,?,?,?,?,?,?,?,'stop',?,?)""",
                    (oid, order["level_index"], order["grid_epoch"],
                     order["buy_fill_price"], sell_price, order["order_size"],
                     pnl, round(fee, 10), self._anchor, order["bought_at"], ts_ms)
                )
            await self._update_bankroll(db, bankroll)
            logger.info("pepe_grid:stop:sold_all", {
                "count": len(self._bought), "price": sell_price
            })

        if self._config_id:
            await db.execute(
                "UPDATE pepe_grid_orders SET status='cancelled' WHERE config_id=? AND status='pending'",
                (self._config_id,)
            )
            await db.execute(
                "UPDATE pepe_grid_config SET status='stopped', updated_at=? WHERE id=?",
                (ts_ms, self._config_id)
            )

        await db.commit()
        self._pending.clear()
        self._bought.clear()
        self._anchor      = None
        self._gi          = None
        self._grid_levels = []
        self._ma_value    = None
        logger.info("pepe_grid:stopped")
        await self._broadcast()

    async def get_status(self) -> dict:
        db = await get_db()
        config = await fetchone(db, "SELECT * FROM pepe_grid_config ORDER BY id DESC LIMIT 1")

        if not config:
            return {"status": "not_configured", "current_price": self._price}

        trades = await fetchall(db, """
            SELECT pt.id, pt.level_index, pt.grid_epoch, pt.buy_price, pt.sell_price,
                   pt.order_size_usd, pt.pnl, pt.fee, pt.anchor_at_trade,
                   pt.close_reason, pt.opened_at, pt.closed_at
            FROM pepe_grid_trades pt
            JOIN pepe_grid_orders po ON pt.order_id = po.id
            WHERE po.config_id = ?
            ORDER BY pt.closed_at DESC
            LIMIT 100
        """, (config["id"],))

        total_pnl   = sum(t["pnl"] for t in trades)
        grid_trades = [t for t in trades if (t.get("close_reason") or "grid") != "stop"]
        wins        = sum(1 for t in grid_trades if t["pnl"] > 0)
        win_rate    = round(wins / len(grid_trades) * 100, 1) if grid_trades else 0
        stop_pnl    = sum(t["pnl"] for t in trades if (t.get("close_reason") or "grid") == "stop")

        # Unrealized P&L from currently bought positions
        unrealized_pnl = 0.0
        if self._price and self._bought:
            fee_pct = CONFIG.pepe_grid_fee_pct
            for order in self._bought.values():
                if order.get("buy_fill_price"):
                    units = order["order_size"] / order["buy_fill_price"]
                    fee   = order["order_size"] * fee_pct * 2
                    unrealized_pnl += units * (self._price - order["buy_fill_price"]) - fee

        if self.running and self._config_id == config["id"]:
            active_orders = sorted(
                [{**o, "status": "pending"} for o in self._pending.values()] +
                [{**o, "status": "bought"}  for o in self._bought.values()],
                key=lambda x: x["level_index"],
                reverse=True,
            )
        else:
            active_orders = await fetchall(db, """
                SELECT * FROM pepe_grid_orders
                WHERE config_id=? AND status IN ('pending','bought')
                ORDER BY level_index DESC
            """, (config["id"],))

        # Build MA history series from candles for chart overlay (all O(N))
        ma_history: list[dict] = []
        if self._candles and len(self._candles) >= self._ma_period:
            closes = [c["close"] for c in self._candles]
            period = self._ma_period
            ma_type = self._ma_type.upper()
            if ma_type in ("EMA", "TEMA"):
                e1 = _ema_series(closes, period)
                if ma_type == "EMA":
                    offset = len(closes) - len(e1)
                    for idx, val in enumerate(e1):
                        c = self._candles[offset + idx]
                        if "open_time" in c:
                            ma_history.append({"time": c["open_time"] // 1000, "value": val})
                else:  # TEMA — needs 3 passes, only emit where all three are valid
                    e2 = _ema_series(e1, period)
                    e3 = _ema_series(e2, period)
                    # e3 is shortest; align all series at their ends
                    n3 = len(e3)
                    if n3 > 0:
                        e1_off = len(e1) - n3
                        e2_off = len(e2) - n3
                        candle_off = len(closes) - n3
                        for i in range(n3):
                            val = 3 * e1[e1_off + i] - 3 * e2[e2_off + i] + e3[i]
                            c = self._candles[candle_off + i]
                            if "open_time" in c:
                                ma_history.append({"time": c["open_time"] // 1000, "value": val})
            elif ma_type == "SMA":
                for idx in range(period - 1, len(closes)):
                    val = sum(closes[idx - period + 1:idx + 1]) / period
                    c = self._candles[idx]
                    if "open_time" in c:
                        ma_history.append({"time": c["open_time"] // 1000, "value": val})
            elif ma_type == "VWMA":
                vols = [c["volume"] for c in self._candles]
                for idx in range(period - 1, len(closes)):
                    tv = sum(vols[idx - period + 1:idx + 1])
                    val = (sum(closes[j] * vols[j] for j in range(idx - period + 1, idx + 1)) / tv
                           if tv else sum(closes[idx - period + 1:idx + 1]) / period)
                    c = self._candles[idx]
                    if "open_time" in c:
                        ma_history.append({"time": c["open_time"] // 1000, "value": val})
            elif ma_type == "LREG":
                for idx in range(period - 1, len(closes)):
                    val = _lreg(closes[:idx + 1], period)
                    c = self._candles[idx]
                    if "open_time" in c:
                        ma_history.append({"time": c["open_time"] // 1000, "value": val})

        return {
            "status":        "running" if self.running else "stopped",
            "current_price": self._price,
            "anchor":        self._anchor,
            "grid_interval": self._gi,
            "grid_levels":   self._grid_levels,
            "grid_epoch":    self._grid_epoch,
            "ma_type":       config["ma_type"],
            "ma_period":     config["ma_period"],
            "interval_pct":  config["interval_pct"],
            "laziness_pct":  config["laziness_pct"],
            "ma_value":      self._ma_value,
            "ma_history":    ma_history,
            "last_reset_at": self._last_reset_at,
            "metrics": {
                "total_pnl":      round(total_pnl, 10),
                "unrealized_pnl": round(unrealized_pnl, 10),
                "stop_pnl":       round(stop_pnl, 10),
                "trade_count":    len(grid_trades),
                "stop_count":     len(trades) - len(grid_trades),
                "win_rate":       win_rate,
                "pending_orders": len([o for o in active_orders if o["status"] == "pending"]),
                "bought_orders":  len([o for o in active_orders if o["status"] == "bought"]),
            },
            "orders":        active_orders,
            "recent_trades": trades[:50],
        }


pepe_grid_engine = AdaptiveGridPepeEngine()
