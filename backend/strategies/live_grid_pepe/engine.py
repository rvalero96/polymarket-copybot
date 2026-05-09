"""
Live Grid PEPE — Adaptive grid on Binance using real orders + User Data Stream.

Differences vs BTC grid:
- Anchor price computed from MA (recomputed every 60s)
- 9 levels ±4 relative to anchor
- Grid resets when anchor drifts > laziness_pct (cancel + replace orders)
- Cooldown per level after buy
"""

import asyncio
import json
import math
import time
from collections import deque

import websockets

from config import CONFIG
from db.connection import get_db
from logger import logger
from services.binance import (
    cancel_all_orders,
    cancel_order,
    fetch_candles,
    fetch_spot_price,
    get_account_balances,
    get_exchange_filters,
    get_listen_key,
    keepalive_listen_key,
    place_limit_order,
    _round_step,
    _round_tick,
)

SYMBOL      = "PEPEUSDT"
LEVELS_SIDE = 4   # ±4 → 8 buy levels + 1 anchor sell level


def _compute_ma(candles: list[dict], ma_type: str, period: int) -> float:
    closes = [c["close"] for c in candles]
    if len(closes) < period:
        return closes[-1] if closes else 0.0
    if ma_type == "SMA":
        return sum(closes[-period:]) / period
    if ma_type in ("EMA", "TEMA"):
        k = 2 / (period + 1)
        ema = closes[0]
        for c in closes[1:]:
            ema = c * k + ema * (1 - k)
        return ema
    return closes[-1]


class LivePepeGridEngine:
    def __init__(self):
        self.running      = False
        self._config_id   = None
        self._price       = 0.0
        self._price_ts    = 0
        self._anchor      = 0.0
        self._grid_interval = 0.0
        self._grid_epoch  = 0

        # binance_order_id → order info
        self._orders: dict[str, dict] = {}
        # level_index → cooldown timestamp
        self._cooldowns: dict[int, float] = {}

        # Config snapshot
        self._order_size_pct  = 0.05
        self._ma_type         = "EMA"
        self._ma_period       = 20
        self._interval_pct    = 0.02
        self._laziness_pct    = 0.015
        self._candle_tf       = "1m"

        # Symbol precision
        self._step_size    = 1.0
        self._tick_size    = 0.0000001
        self._min_notional = 10.0
        self._order_size   = 0.0

        self._candles: list[dict] = []

        # Tasks
        self._price_task     = None
        self._uds_task       = None
        self._candle_task    = None
        self._keepalive_task = None
        self._listen_key     = None

        self._subscribers: list[asyncio.Queue] = []

    # ── Public API ──────────────────────────────────────────────────────────

    async def start(self, order_size_pct: float, ma_type: str = "EMA", ma_period: int = 20,
                    interval_pct: float = 0.02, laziness_pct: float = 0.015):
        if self.running:
            raise RuntimeError("Already running")

        db = await get_db("live")

        # 1. Balance → order size
        balances   = await get_account_balances()
        usdt_free  = (balances.get("USDT") or {}).get("free", 0.0)
        usdc_free  = (balances.get("USDC") or {}).get("free", 0.0)
        bankroll   = usdt_free + usdc_free
        order_size = round(bankroll * order_size_pct, 2)
        self._order_size = order_size

        # 2. Exchange filters
        filters = await get_exchange_filters(SYMBOL)
        self._step_size    = filters["step_size"]
        self._tick_size    = filters["tick_size"]
        self._min_notional = filters["min_notional"]

        # 3. Candles → anchor price
        self._candles = await fetch_candles(SYMBOL, interval=CONFIG.pepe_grid_candle_tf, limit=500)
        anchor = _compute_ma(self._candles, ma_type, ma_period)
        grid_interval = anchor * interval_pct
        self._anchor        = anchor
        self._grid_interval = grid_interval

        # 4. Save config
        now_ms = int(time.time() * 1000)
        cur = await db.execute(
            """INSERT INTO pepe_grid_config
               (order_size, order_size_pct, ma_type, ma_period, interval_pct, laziness_pct,
                candle_tf, anchor_price, grid_interval, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)""",
            (order_size, order_size_pct, ma_type, ma_period, interval_pct, laziness_pct,
             CONFIG.pepe_grid_candle_tf, anchor, grid_interval, now_ms, now_ms),
        )
        await db.commit()
        self._config_id = cur.lastrowid

        # 5. Save epoch
        await db.execute(
            """INSERT INTO pepe_grid_epoch_history
               (config_id, grid_epoch, anchor_price, grid_interval, interval_pct, started_at)
               VALUES (?, 0, ?, ?, ?, ?)""",
            (self._config_id, anchor, grid_interval, interval_pct, now_ms),
        )
        await db.commit()

        # 6. Place initial buy orders
        self._order_size_pct = order_size_pct
        self._ma_type        = ma_type
        self._ma_period      = ma_period
        self._interval_pct   = interval_pct
        self._laziness_pct   = laziness_pct
        self._candle_tf      = CONFIG.pepe_grid_candle_tf
        self._grid_epoch     = 0

        await self._place_grid_orders(db)

        self.running = True
        self._listen_key     = await get_listen_key()
        self._uds_task       = asyncio.create_task(self._uds_loop())
        self._price_task     = asyncio.create_task(self._price_loop())
        self._candle_task    = asyncio.create_task(self._candle_refresh_loop())
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

        logger.info("live_grid_pepe:started", {"config_id": self._config_id, "anchor": anchor})
        self._broadcast()
        ref_price = await fetch_spot_price(SYMBOL)
        return {"config_id": self._config_id, "anchor": anchor, "grid_interval": grid_interval, "ref_price": ref_price}

    async def stop(self):
        if not self.running:
            return
        self.running = False

        for task in (self._uds_task, self._price_task, self._candle_task, self._keepalive_task):
            if task:
                task.cancel()

        try:
            await cancel_all_orders(SYMBOL)
        except Exception as e:
            logger.error("live_grid_pepe:cancel_all:error", {"error": str(e)})

        db = await get_db("live")
        now_ms = int(time.time() * 1000)
        if self._config_id:
            await db.execute(
                "UPDATE pepe_grid_config SET status='stopped', updated_at=? WHERE id=?",
                (now_ms, self._config_id),
            )
            await db.execute(
                "UPDATE pepe_grid_orders SET status='cancelled' WHERE config_id=? AND status IN ('pending','bought')",
                (self._config_id,),
            )
            await db.commit()

        self._orders.clear()
        self._cooldowns.clear()
        self._config_id  = None
        self._listen_key = None
        logger.info("live_grid_pepe:stopped")
        self._broadcast()

    def get_status(self) -> dict:
        orders_list = list(self._orders.values())
        pending = [o for o in orders_list if o["side"] == "buy"]
        bought  = [o for o in orders_list if o["side"] == "sell"]
        return {
            "running":        self.running,
            "config_id":      self._config_id,
            "price":          self._price,
            "price_ts":       self._price_ts,
            "anchor":         self._anchor,
            "grid_interval":  self._grid_interval,
            "grid_epoch":     self._grid_epoch,
            "ma_type":        self._ma_type,
            "ma_period":      self._ma_period,
            "interval_pct":   self._interval_pct,
            "laziness_pct":   self._laziness_pct,
            "order_size_pct": self._order_size_pct,
            "pending_count":  len(pending),
            "bought_count":   len(bought),
            "total_orders":   len(orders_list),
        }

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=20)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self._subscribers = [s for s in self._subscribers if s is not q]

    # ── Grid helpers ────────────────────────────────────────────────────────

    def _level_prices(self) -> list[dict]:
        """Returns buy/sell prices for levels -LEVELS_SIDE to +LEVELS_SIDE-1."""
        levels = []
        for i in range(LEVELS_SIDE * 2):
            level_index = LEVELS_SIDE - i          # +4 down to -3
            buy_price   = self._anchor + level_index * self._grid_interval
            sell_price  = buy_price + self._grid_interval
            if buy_price <= 0:
                continue
            levels.append({
                "level_index": LEVELS_SIDE - level_index,  # 0..7 for DB
                "buy_price":   _round_tick(buy_price,  self._tick_size),
                "sell_price":  _round_tick(sell_price, self._tick_size),
            })
        return levels

    async def _place_grid_orders(self, db):
        """Place BUY limit orders for all pending levels."""
        covered = {o["level_index"] for o in self._orders.values()}
        for lv in self._level_prices():
            if lv["level_index"] in covered:
                continue
            cooldown = self._cooldowns.get(lv["level_index"], 0)
            if time.monotonic() < cooldown:
                continue
            qty = _round_step(self._order_size / lv["buy_price"], self._step_size)
            if qty * lv["buy_price"] < self._min_notional:
                continue
            try:
                resp = await place_limit_order(SYMBOL, "BUY", qty, lv["buy_price"])
                binance_id = str(resp["orderId"])
            except Exception as e:
                logger.error("live_grid_pepe:place_buy:error", {"level": lv["level_index"], "error": str(e)})
                continue

            cur = await db.execute(
                """INSERT INTO pepe_grid_orders
                   (config_id, grid_epoch, level_index, buy_price, sell_price, order_size, status, binance_order_id)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)""",
                (self._config_id, self._grid_epoch, lv["level_index"],
                 lv["buy_price"], lv["sell_price"], self._order_size, binance_id),
            )
            await db.commit()

            self._orders[binance_id] = {
                "db_order_id":  cur.lastrowid,
                "level_index":  lv["level_index"],
                "side":         "buy",
                "buy_price":    lv["buy_price"],
                "sell_price":   lv["sell_price"],
                "order_size":   self._order_size,
                "qty":          qty,
                "bought_at":    None,
                "buy_fill":     None,
            }

    async def _reset_grid(self, db):
        """Cancel orders outside new grid range and place new ones."""
        self._grid_epoch += 1
        now_ms = int(time.time() * 1000)

        new_levels  = {lv["level_index"]: lv for lv in self._level_prices()}
        valid_idxs  = set(new_levels.keys())

        # Cancel pending orders whose level_index is outside new range
        to_cancel = [
            (bid, o) for bid, o in list(self._orders.items())
            if o["side"] == "buy" and o["level_index"] not in valid_idxs
        ]
        for binance_id, order in to_cancel:
            try:
                await cancel_order(SYMBOL, int(binance_id))
            except Exception:
                pass
            await db.execute(
                "UPDATE pepe_grid_orders SET status='cancelled' WHERE id=?",
                (order["db_order_id"],),
            )
            del self._orders[binance_id]

        await db.execute(
            "UPDATE pepe_grid_config SET anchor_price=?, grid_interval=?, updated_at=? WHERE id=?",
            (self._anchor, self._grid_interval, now_ms, self._config_id),
        )
        await db.execute(
            """INSERT INTO pepe_grid_epoch_history
               (config_id, grid_epoch, anchor_price, grid_interval, interval_pct, started_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (self._config_id, self._grid_epoch, self._anchor, self._grid_interval,
             self._interval_pct, now_ms),
        )
        await db.commit()

        await self._place_grid_orders(db)
        logger.info("live_grid_pepe:grid_reset", {"epoch": self._grid_epoch, "anchor": self._anchor})

    # ── Internal loops ──────────────────────────────────────────────────────

    async def _price_loop(self):
        backoff = 1
        ws_url = CONFIG.pepe_grid_ws_url
        while self.running:
            try:
                async with websockets.connect(ws_url, ping_interval=20) as ws:
                    backoff = 1
                    async for raw in ws:
                        if not self.running:
                            break
                        msg = json.loads(raw)
                        if "p" in msg:
                            self._price    = float(msg["p"])
                            self._price_ts = int(msg.get("T", time.time() * 1000))
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warn("live_grid_pepe:price_ws:reconnect", {"error": str(e)})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    async def _uds_loop(self):
        backoff = 1
        while self.running:
            try:
                url = f"{CONFIG.binance_ws_base}/{self._listen_key}"
                async with websockets.connect(url, ping_interval=20) as ws:
                    backoff = 1
                    async for raw in ws:
                        if not self.running:
                            break
                        msg = json.loads(raw)
                        if msg.get("e") == "executionReport" and msg.get("X") == "FILLED":
                            await self._on_fill(msg)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warn("live_grid_pepe:uds:reconnect", {"error": str(e)})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    async def _candle_refresh_loop(self):
        while self.running:
            await asyncio.sleep(60)
            if not self.running:
                break
            try:
                self._candles = await fetch_candles(SYMBOL, interval=self._candle_tf, limit=500)
                new_anchor    = _compute_ma(self._candles, self._ma_type, self._ma_period)
                drift = abs(new_anchor - self._anchor) / self._anchor if self._anchor else 0
                if drift > self._laziness_pct:
                    self._anchor        = new_anchor
                    self._grid_interval = new_anchor * self._interval_pct
                    db = await get_db("live")
                    await self._reset_grid(db)
                    self._broadcast()
            except Exception as e:
                logger.error("live_grid_pepe:candle_refresh:error", {"error": str(e)})

    async def _keepalive_loop(self):
        while self.running:
            await asyncio.sleep(1800)
            if self._listen_key and self.running:
                try:
                    await keepalive_listen_key(self._listen_key)
                except Exception as e:
                    logger.error("live_grid_pepe:keepalive:error", {"error": str(e)})

    async def _on_fill(self, msg: dict):
        order_id = str(msg["i"])
        side     = msg["S"]
        fill_px  = float(msg["L"])
        qty      = float(msg["z"])
        ts_ms    = int(msg.get("T", time.time() * 1000))

        order = self._orders.get(order_id)
        if not order:
            return

        db = await get_db("live")
        if side == "BUY":
            await self._handle_buy_filled(db, order_id, order, fill_px, qty, ts_ms)
        elif side == "SELL":
            await self._handle_sell_filled(db, order_id, order, fill_px, qty, ts_ms)
        self._broadcast()

    async def _handle_buy_filled(self, db, binance_buy_id, order, fill_px, qty, ts_ms):
        await db.execute(
            "UPDATE pepe_grid_orders SET status='bought', buy_fill_price=?, bought_at=? WHERE id=?",
            (fill_px, ts_ms, order["db_order_id"]),
        )
        await db.commit()

        # Cooldown for this level
        self._cooldowns[order["level_index"]] = time.monotonic() + CONFIG.pepe_grid_cooldown_s

        sell_qty = _round_step(qty, self._step_size)
        sell_px  = _round_tick(order["sell_price"], self._tick_size)
        try:
            resp = await place_limit_order(SYMBOL, "SELL", sell_qty, sell_px)
            sell_binance_id = str(resp["orderId"])
        except Exception as e:
            logger.error("live_grid_pepe:place_sell:error", {"error": str(e)})
            return

        await db.execute(
            "UPDATE pepe_grid_orders SET binance_order_id=? WHERE id=?",
            (sell_binance_id, order["db_order_id"]),
        )
        await db.commit()

        del self._orders[binance_buy_id]
        self._orders[sell_binance_id] = {**order, "side": "sell", "bought_at": ts_ms, "buy_fill": fill_px, "qty": sell_qty}
        logger.info("live_grid_pepe:buy_filled", {"level": order["level_index"], "fill_px": fill_px})

    async def _handle_sell_filled(self, db, binance_sell_id, order, fill_px, qty, ts_ms):
        now_ms   = int(time.time() * 1000)
        buy_fill = order.get("buy_fill") or fill_px
        fee      = order["order_size"] * CONFIG.pepe_grid_fee_pct * 2
        pnl      = round((fill_px - buy_fill) * qty - fee, 10)

        await db.execute(
            "UPDATE pepe_grid_orders SET status='closed', sell_fill_price=?, sold_at=? WHERE id=?",
            (fill_px, ts_ms, order["db_order_id"]),
        )
        await db.execute(
            """INSERT INTO pepe_grid_trades
               (order_id, level_index, grid_epoch, buy_price, sell_price, order_size_usd,
                pnl, fee, anchor_at_trade, close_reason, opened_at, closed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'grid', ?, ?)""",
            (order["db_order_id"], order["level_index"], self._grid_epoch,
             buy_fill, fill_px, order["order_size"], pnl, fee,
             self._anchor, order.get("bought_at") or now_ms, ts_ms),
        )
        await db.commit()

        # Recycle buy order
        new_qty = _round_step(order["order_size"] / order["buy_price"], self._step_size)
        new_px  = _round_tick(order["buy_price"], self._tick_size)
        try:
            resp = await place_limit_order(SYMBOL, "BUY", new_qty, new_px)
            new_binance_id = str(resp["orderId"])
        except Exception as e:
            logger.error("live_grid_pepe:recycle_buy:error", {"error": str(e)})
            del self._orders[binance_sell_id]
            return

        cur = await db.execute(
            """INSERT INTO pepe_grid_orders
               (config_id, grid_epoch, level_index, buy_price, sell_price, order_size, status, binance_order_id)
               VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)""",
            (self._config_id, self._grid_epoch, order["level_index"],
             order["buy_price"], order["sell_price"], order["order_size"], new_binance_id),
        )
        await db.commit()

        del self._orders[binance_sell_id]
        self._orders[new_binance_id] = {
            "db_order_id": cur.lastrowid, "level_index": order["level_index"],
            "side": "buy", "buy_price": order["buy_price"], "sell_price": order["sell_price"],
            "order_size": order["order_size"], "qty": new_qty, "bought_at": None, "buy_fill": None,
        }
        logger.info("live_grid_pepe:sell_filled", {"level": order["level_index"], "pnl": pnl})

    def _broadcast(self):
        status = self.get_status()
        for q in self._subscribers[:]:
            try:
                q.put_nowait(status)
            except asyncio.QueueFull:
                pass
