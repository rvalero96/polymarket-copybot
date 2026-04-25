import asyncio
import json
import time
from collections import deque

import httpx
import websockets

from config import CONFIG
from db.connection import get_db, fetchall, fetchone
from logger import logger
from services.binance import fetch_spot_price

TF_SECONDS = {'1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400}
FEE_PCT    = CONFIG.stoch_btc_fee_pct


def _calc_stochastic(candles: list[dict], k_period: int, d_period: int) -> list[dict]:
    result = []
    n = len(candles)
    for i in range(k_period - 1, n):
        window       = candles[i - k_period + 1 : i + 1]
        lowest_low   = min(c['low']  for c in window)
        highest_high = max(c['high'] for c in window)
        denom = highest_high - lowest_low
        k = 50.0 if denom == 0 else (candles[i]['close'] - lowest_low) / denom * 100.0
        result.append({'time': candles[i]['time'], 'k': k, 'd': None})
    for i in range(d_period - 1, len(result)):
        result[i]['d'] = sum(result[j]['k'] for j in range(i - d_period + 1, i + 1)) / d_period
    return result


class StochBtcEngine:
    def __init__(self):
        self._task:           asyncio.Task | None = None
        self._price:          float | None = None
        self.running:         bool = False
        self._config_id:      int | None = None
        self._k_period:       int = 14
        self._d_period:       int = 3
        self._candle_tf:      str = '5m'
        self._order_size_pct: float = 0.05
        self._candles:        deque = deque(maxlen=500)
        self._current_candle: dict | None = None
        self._position:       dict | None = None
        self._last_k:         float | None = None
        self._last_d:         float | None = None
        self._prev_k:         float | None = None
        self._prev_d:         float | None = None
        self._subscribers:    list[asyncio.Queue] = []
        self._start_lock:     asyncio.Lock = asyncio.Lock()

    # ── Pub/sub ───────────────────────────────────────────────────────────────

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

    # ── Bankroll helpers ───────────────────────────────────────────────────────

    async def _get_bankroll(self, db) -> float:
        snap = await fetchone(db, "SELECT bankroll FROM snapshots ORDER BY date DESC LIMIT 1")
        return (snap or {}).get("bankroll") or CONFIG.paper_bankroll

    async def _update_bankroll(self, db, bankroll: float) -> None:
        import datetime
        today  = datetime.date.today().isoformat()
        now_ms = int(time.time() * 1000)
        await db.execute("""
            INSERT INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
            VALUES (?, ?, 0, ?, 0, NULL, ?)
            ON CONFLICT(date) DO UPDATE SET
                bankroll   = excluded.bankroll,
                pnl_total  = excluded.pnl_total,
                created_at = excluded.created_at
        """, (today, bankroll, bankroll - CONFIG.paper_bankroll, now_ms))

    # ── Public API ─────────────────────────────────────────────────────────────

    async def start(self, k_period: int, d_period: int, candle_tf: str, order_size_pct: float) -> dict:
        if self._start_lock.locked():
            return {"ok": False, "error": "Stoch start already in progress"}
        async with self._start_lock:
            return await self._start_inner(k_period, d_period, candle_tf, order_size_pct)

    async def _start_inner(self, k_period: int, d_period: int, candle_tf: str, order_size_pct: float) -> dict:
        if self.running:
            return {"ok": False, "error": "Stoch BTC already running"}
        if candle_tf not in TF_SECONDS:
            return {"ok": False, "error": f"Invalid candle_tf: {candle_tf}"}
        if not (2 <= k_period <= 200):
            return {"ok": False, "error": "k_period must be between 2 and 200"}
        if not (1 <= d_period <= 50):
            return {"ok": False, "error": "d_period must be between 1 and 50"}

        self._k_period       = k_period
        self._d_period       = d_period
        self._candle_tf      = candle_tf
        self._order_size_pct = order_size_pct
        self._candles.clear()
        self._current_candle = None
        self._position       = None
        self._last_k         = None
        self._last_d         = None
        self._prev_k         = None
        self._prev_d         = None

        # Warm up from Binance REST klines
        try:
            warm = await self._fetch_klines(candle_tf, limit=100)
            for c in warm[:-1]:
                self._candles.append(c)
            if warm:
                self._current_candle = dict(warm[-1])
            logger.info("stoch_btc:warmup", {"candles": len(self._candles)})
        except Exception as e:
            logger.error("stoch_btc:warmup:error", {"error": str(e)})

        if len(self._candles) >= k_period:
            stoch = _calc_stochastic(list(self._candles), k_period, d_period)
            if stoch and stoch[-1]['d'] is not None:
                self._last_k = stoch[-1]['k']
                self._last_d = stoch[-1]['d']

        try:
            self._price = await fetch_spot_price("BTCUSDT")
        except Exception:
            pass

        db     = await get_db()
        now_ms = int(time.time() * 1000)
        await db.execute(
            "UPDATE stoch_btc_config SET status='stopped', updated_at=? WHERE status='running'",
            (now_ms,)
        )
        async with db.execute(
            """INSERT INTO stoch_btc_config
               (k_period, d_period, candle_tf, order_size_pct, status, created_at, updated_at)
               VALUES (?,?,?,?,'running',?,?)""",
            (k_period, d_period, candle_tf, order_size_pct, now_ms, now_ms)
        ) as cur:
            self._config_id = cur.lastrowid
        await db.commit()

        self.running = True
        self._task   = asyncio.create_task(self._ws_loop())

        def _on_done(task):
            if not self.running:
                return
            if not task.cancelled() and task.exception() is not None:
                logger.error("stoch_btc:task:died", {"error": str(task.exception())})
                asyncio.create_task(self.stop())

        self._task.add_done_callback(_on_done)
        logger.info("stoch_btc:started", {
            "config_id": self._config_id, "k_period": k_period,
            "d_period": d_period, "candle_tf": candle_tf,
        })
        asyncio.create_task(self._broadcast())
        return {"ok": True, "config_id": self._config_id, "k": self._last_k, "d": self._last_d}

    async def stop(self) -> None:
        self.running = False
        if self._task:
            if not self._task.done():
                self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

        if self._position and self._price:
            await self._close_position(self._price, self._last_k or 0, self._last_d or 0, reason="stop")

        db     = await get_db()
        now_ms = int(time.time() * 1000)
        if self._config_id:
            await db.execute(
                "UPDATE stoch_btc_config SET status='stopped', updated_at=? WHERE id=?",
                (now_ms, self._config_id)
            )
        await db.commit()
        self._config_id = None
        logger.info("stoch_btc:stopped")
        await self._broadcast()

    async def get_status(self) -> dict:
        db     = await get_db()
        config = await fetchone(db, "SELECT * FROM stoch_btc_config ORDER BY id DESC LIMIT 1")

        if not config:
            return {
                "status":        "not_configured",
                "current_price": self._price,
                "current_k":     self._last_k,
                "current_d":     self._last_d,
            }

        trades = await fetchall(db, """
            SELECT * FROM stoch_btc_trades
            WHERE config_id = ? AND status = 'closed'
            ORDER BY closed_at DESC LIMIT 50
        """, (config["id"],))

        signals = await fetchall(db, """
            SELECT * FROM stoch_btc_signals
            WHERE config_id = ?
            ORDER BY triggered_at DESC LIMIT 50
        """, (config["id"],))

        total_pnl = sum(t["pnl"] for t in trades if t["pnl"] is not None)
        wins      = sum(1 for t in trades if (t["pnl"] or 0) > 0)
        win_rate  = round(wins / len(trades) * 100, 1) if trades else 0

        k = self._last_k
        zone = "neutral"
        if k is not None:
            if k > 80:
                zone = "overbought"
            elif k < 20:
                zone = "oversold"

        unrealized_pnl = None
        if self._position and self._price:
            buy_p = self._position["buy_price"]
            size  = self._position["order_size"]
            fee   = size * FEE_PCT * 2
            unrealized_pnl = round((size / buy_p) * (self._price - buy_p) - fee, 4)

        return {
            "status":        "running" if self.running else "stopped",
            "current_price": self._price,
            "k_period":      config["k_period"],
            "d_period":      config["d_period"],
            "candle_tf":     config["candle_tf"],
            "current_k":     round(self._last_k, 2) if self._last_k is not None else None,
            "current_d":     round(self._last_d, 2) if self._last_d is not None else None,
            "zone":          zone,
            "position":      {**self._position, "unrealized_pnl": unrealized_pnl} if self._position else None,
            "metrics": {
                "total_pnl":    round(total_pnl, 4),
                "trade_count":  len(trades),
                "win_rate":     win_rate,
                "signal_count": len(signals),
            },
            "recent_signals": [dict(s) for s in signals[:20]],
            "recent_trades":  [dict(t) for t in trades[:20]],
        }

    # ── Klines fetch ───────────────────────────────────────────────────────────

    async def _fetch_klines(self, tf: str, limit: int = 100) -> list[dict]:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{CONFIG.binance_base}/klines",
                params={"symbol": "BTCUSDT", "interval": tf, "limit": limit},
            )
            resp.raise_for_status()
            raw = resp.json()
        return [
            {
                "time":  int(k[0]) // 1000,
                "open":  float(k[1]),
                "high":  float(k[2]),
                "low":   float(k[3]),
                "close": float(k[4]),
            }
            for k in raw
        ]

    # ── WebSocket loop ─────────────────────────────────────────────────────────

    async def _ws_loop(self):
        backoff = 1.0
        while self.running:
            ws_url = f"wss://stream.binance.com/ws/btcusdt@kline_{self._candle_tf}"
            try:
                async with websockets.connect(ws_url, ping_interval=20) as ws:
                    logger.info("stoch_btc:ws:connected", {"url": ws_url})
                    backoff = 1.0
                    async for raw in ws:
                        if not self.running:
                            break
                        msg = json.loads(raw)
                        k   = msg.get("k", {})
                        candle = {
                            "time":  int(k["t"]) // 1000,
                            "open":  float(k["o"]),
                            "high":  float(k["h"]),
                            "low":   float(k["l"]),
                            "close": float(k["c"]),
                        }
                        is_closed = k.get("x", False)
                        self._price = candle["close"]
                        await self._on_kline(candle, is_closed)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("stoch_btc:ws:error", {"error": str(exc), "retry_in": backoff})
                if self.running:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)

    # ── Kline processing ───────────────────────────────────────────────────────

    async def _on_kline(self, candle: dict, is_closed: bool) -> None:
        self._current_candle = dict(candle)
        if is_closed:
            self._candles.append(dict(candle))
            await self._on_candle_close(candle)

    async def _on_candle_close(self, candle: dict) -> None:
        candles = list(self._candles)
        if len(candles) < self._k_period:
            return

        stoch = _calc_stochastic(candles, self._k_period, self._d_period)
        if len(stoch) < 2:
            return

        prev_k = self._last_k
        prev_d = self._last_d
        curr   = stoch[-1]

        self._last_k = curr['k']
        self._last_d = curr['d']

        if curr['d'] is None or prev_k is None or prev_d is None:
            return

        price = candle['close']

        # Buy: oversold zone + bullish crossover (%K crosses above %D from below)
        if curr['k'] < 20 and prev_k < prev_d and curr['k'] >= curr['d']:
            if not self._position:
                await self._open_position(price, curr['k'], curr['d'])
                asyncio.create_task(self._broadcast())
                return

        # Sell: overbought zone + bearish crossover (%K crosses below %D from above)
        if curr['k'] > 80 and prev_k > prev_d and curr['k'] <= curr['d']:
            if self._position:
                await self._close_position(price, curr['k'], curr['d'])
                asyncio.create_task(self._broadcast())

    # ── Trade management ───────────────────────────────────────────────────────

    async def _open_position(self, price: float, k: float, d: float) -> None:
        if not self._config_id:
            return
        db         = await get_db()
        bankroll   = await self._get_bankroll(db)
        order_size = round(bankroll * self._order_size_pct, 2)
        now_ms     = int(time.time() * 1000)

        async with db.execute(
            """INSERT INTO stoch_btc_trades
               (config_id, buy_price, order_size, fee, k_at_buy, d_at_buy, status, opened_at)
               VALUES (?,?,?,?,?,?,'open',?)""",
            (self._config_id, price, order_size, round(order_size * FEE_PCT, 4), k, d, now_ms)
        ) as cur:
            trade_id = cur.lastrowid

        await db.execute(
            """INSERT INTO stoch_btc_signals
               (config_id, signal_type, k_val, d_val, price, triggered_at)
               VALUES (?,?,?,?,?,?)""",
            (self._config_id, 'buy', k, d, price, now_ms)
        )
        await self._update_bankroll(db, bankroll - order_size)
        await db.commit()

        self._position = {
            "id": trade_id, "buy_price": price, "order_size": order_size,
            "k_at_buy": k, "d_at_buy": d, "opened_at": now_ms,
        }
        logger.info("stoch_btc:buy", {"price": price, "k": round(k, 2), "d": round(d, 2), "size": order_size})

    async def _close_position(self, sell_price: float, k_val: float, d_val: float, reason: str = "signal") -> None:
        if not self._position or not self._config_id:
            return
        pos    = self._position
        now_ms = int(time.time() * 1000)
        fee    = pos["order_size"] * FEE_PCT * 2
        pnl    = round((pos["order_size"] / pos["buy_price"]) * (sell_price - pos["buy_price"]) - fee, 4)

        db = await get_db()
        bankroll = await self._get_bankroll(db)
        await db.execute(
            """UPDATE stoch_btc_trades
               SET sell_price=?, pnl=?, fee=?, k_at_sell=?, d_at_sell=?, status='closed', closed_at=?
               WHERE id=?""",
            (sell_price, pnl, round(fee, 4), k_val, d_val, now_ms, pos["id"])
        )
        await db.execute(
            """INSERT INTO stoch_btc_signals
               (config_id, signal_type, k_val, d_val, price, triggered_at)
               VALUES (?,?,?,?,?,?)""",
            (self._config_id, 'sell', k_val, d_val, sell_price, now_ms)
        )
        await self._update_bankroll(db, bankroll + pos["order_size"] + pnl)
        await db.commit()

        self._position = None
        logger.info("stoch_btc:sell", {
            "price": sell_price, "pnl": pnl, "reason": reason,
            "k": round(k_val, 2), "d": round(d_val, 2),
        })


stoch_btc_engine = StochBtcEngine()
