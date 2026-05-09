"""
Live Grid BTC — Real Binance orders via REST + User Data Stream.

Flow:
  start()  → fetch balance + exchange filters → place BUY limit orders → open UDS WebSocket
  UDS fill → BUY filled  → place SELL limit at sell_price
           → SELL filled → record trade, place new BUY at buy_price
  stop()   → cancel all open orders → mark DB closed
"""

import asyncio
import json
import time

import websockets

from config import CONFIG
from db.connection import get_db
from logger import logger
from services.binance import (
    cancel_all_orders,
    fetch_spot_price,
    get_account_balances,
    get_exchange_filters,
    get_listen_key,
    keepalive_listen_key,
    place_limit_order,
    _round_step,
    _round_tick,
)

SYMBOL = "BTCUSDT"


class LiveGridEngine:
    def __init__(self):
        self.running     = False
        self._config_id  = None
        self._price      = 0.0
        self._price_ts   = 0

        # binance_order_id (str) → order info
        self._orders: dict[str, dict] = {}

        # Symbol precision
        self._step_size    = 0.00001
        self._tick_size    = 0.01
        self._min_notional = 10.0

        # Config snapshot
        self._order_size_pct = 0.05
        self._grid_min       = 0.0
        self._grid_max       = 0.0
        self._levels         = 10

        # Tasks
        self._price_task     = None
        self._uds_task       = None
        self._keepalive_task = None
        self._listen_key     = None

        # SSE
        self._subscribers: list[asyncio.Queue] = []

    # ── Public API ──────────────────────────────────────────────────────────

    async def start(self, grid_min: float, grid_max: float, levels: int, order_size_pct: float):
        if self.running:
            raise RuntimeError("Already running")

        db = await get_db("live")

        # 1. Fetch balance and compute order size
        balances    = await get_account_balances()
        usdt_free   = (balances.get("USDT") or {}).get("free", 0.0)
        usdc_free   = (balances.get("USDC") or {}).get("free", 0.0)
        bankroll    = usdt_free + usdc_free
        order_size  = round(bankroll * order_size_pct, 2)

        # 2. Exchange filters for rounding
        filters = await get_exchange_filters(SYMBOL)
        self._step_size    = filters["step_size"]
        self._tick_size    = filters["tick_size"]
        self._min_notional = filters["min_notional"]

        # 3. Current price
        ref_price = await fetch_spot_price(SYMBOL)
        self._price = ref_price

        # 4. Build grid levels
        spacing = (grid_max - grid_min) / levels
        levels_data = []
        for i in range(levels):
            buy_price  = _round_tick(grid_min + i * spacing, self._tick_size)
            sell_price = _round_tick(buy_price + spacing,    self._tick_size)
            levels_data.append({"level": i, "buy_price": buy_price, "sell_price": sell_price})

        # 5. Save config to live.db
        now_ms = int(time.time() * 1000)
        cur = await db.execute(
            """INSERT INTO grid_config
               (grid_min, grid_max, levels, order_size, order_size_pct, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'running', ?, ?)""",
            (grid_min, grid_max, levels, order_size, order_size_pct, now_ms, now_ms),
        )
        await db.commit()
        self._config_id = cur.lastrowid

        # 6. Place BUY limit orders and save to DB
        self._orders.clear()
        for lv in levels_data:
            qty = _round_step(order_size / lv["buy_price"], self._step_size)
            if qty * lv["buy_price"] < self._min_notional:
                logger.warn("live_grid:order_too_small", {"level": lv["level"], "notional": qty * lv["buy_price"]})
                continue
            try:
                resp = await place_limit_order(SYMBOL, "BUY", qty, lv["buy_price"])
                binance_id = str(resp["orderId"])
            except Exception as e:
                logger.error("live_grid:place_buy:error", {"level": lv["level"], "error": str(e)})
                continue

            cur2 = await db.execute(
                """INSERT INTO grid_orders
                   (config_id, level, buy_price, sell_price, order_size, status, binance_order_id)
                   VALUES (?, ?, ?, ?, ?, 'pending', ?)""",
                (self._config_id, lv["level"], lv["buy_price"], lv["sell_price"], order_size, binance_id),
            )
            await db.commit()
            db_order_id = cur2.lastrowid

            self._orders[binance_id] = {
                "db_order_id":  db_order_id,
                "level":        lv["level"],
                "side":         "buy",
                "buy_price":    lv["buy_price"],
                "sell_price":   lv["sell_price"],
                "order_size":   order_size,
                "qty":          qty,
                "bought_at":    None,
                "buy_fill":     None,
            }

        # 7. Save config snapshot
        self._order_size_pct = order_size_pct
        self._grid_min = grid_min
        self._grid_max = grid_max
        self._levels   = levels
        self.running   = True

        # 8. Open User Data Stream + price feed
        self._listen_key     = await get_listen_key()
        self._uds_task       = asyncio.create_task(self._uds_loop())
        self._price_task     = asyncio.create_task(self._price_loop())
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

        logger.info("live_grid:started", {"config_id": self._config_id, "orders": len(self._orders)})
        self._broadcast()
        return {"config_id": self._config_id, "orders": len(self._orders), "ref_price": ref_price}

    async def stop(self):
        if not self.running:
            return
        self.running = False

        for task in (self._uds_task, self._price_task, self._keepalive_task):
            if task:
                task.cancel()

        try:
            await cancel_all_orders(SYMBOL)
        except Exception as e:
            logger.error("live_grid:cancel_all:error", {"error": str(e)})

        db = await get_db("live")
        now_ms = int(time.time() * 1000)
        if self._config_id:
            await db.execute(
                "UPDATE grid_config SET status='stopped', updated_at=? WHERE id=?",
                (now_ms, self._config_id),
            )
            await db.execute(
                "UPDATE grid_orders SET status='cancelled' WHERE config_id=? AND status IN ('pending','bought')",
                (self._config_id,),
            )
            await db.commit()

        self._orders.clear()
        self._config_id  = None
        self._listen_key = None
        logger.info("live_grid:stopped")
        self._broadcast()

    def get_status(self) -> dict:
        orders_list = list(self._orders.values())
        pending = [o for o in orders_list if o["side"] == "buy"]
        bought  = [o for o in orders_list if o["side"] == "sell"]
        return {
            "running":       self.running,
            "config_id":     self._config_id,
            "price":         self._price,
            "price_ts":      self._price_ts,
            "grid_min":      self._grid_min,
            "grid_max":      self._grid_max,
            "levels":        self._levels,
            "order_size_pct": self._order_size_pct,
            "pending_count": len(pending),
            "bought_count":  len(bought),
            "total_orders":  len(orders_list),
        }

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=20)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self._subscribers = [s for s in self._subscribers if s is not q]

    # ── Internal loops ──────────────────────────────────────────────────────

    async def _price_loop(self):
        backoff = 1
        while self.running:
            try:
                async with websockets.connect(
                    f"{CONFIG.grid_ws_url.rsplit('@', 1)[0].rsplit('/', 1)[0]}/btcusdt@aggTrade",
                    ping_interval=20,
                ) as ws:
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
                logger.warn("live_grid:price_ws:reconnect", {"error": str(e), "backoff": backoff})
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
                logger.warn("live_grid:uds:reconnect", {"error": str(e), "backoff": backoff})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    async def _keepalive_loop(self):
        while self.running:
            await asyncio.sleep(1800)  # 30 min
            if self._listen_key and self.running:
                try:
                    await keepalive_listen_key(self._listen_key)
                except Exception as e:
                    logger.error("live_grid:keepalive:error", {"error": str(e)})

    async def _on_fill(self, msg: dict):
        order_id = str(msg["i"])
        side     = msg["S"]           # BUY or SELL
        fill_px  = float(msg["L"])    # last fill price
        qty      = float(msg["z"])    # cumulative filled qty
        ts_ms    = int(msg.get("T", time.time() * 1000))

        order = self._orders.get(order_id)
        if not order:
            return  # not our order

        db = await get_db("live")

        if side == "BUY":
            await self._handle_buy_filled(db, order_id, order, fill_px, qty, ts_ms)
        elif side == "SELL":
            await self._handle_sell_filled(db, order_id, order, fill_px, qty, ts_ms)

        self._broadcast()

    async def _handle_buy_filled(self, db, binance_buy_id: str, order: dict, fill_px: float, qty: float, ts_ms: int):
        # Update DB: status = bought
        await db.execute(
            "UPDATE grid_orders SET status='bought', buy_fill_price=?, bought_at=?, binance_order_id=? WHERE id=?",
            (fill_px, ts_ms, binance_buy_id, order["db_order_id"]),
        )
        await db.commit()

        # Place SELL limit order
        sell_qty = _round_step(qty, self._step_size)
        sell_px  = _round_tick(order["sell_price"], self._tick_size)
        try:
            resp = await place_limit_order(SYMBOL, "SELL", sell_qty, sell_px)
            sell_binance_id = str(resp["orderId"])
        except Exception as e:
            logger.error("live_grid:place_sell:error", {"error": str(e)})
            return

        # Update binance_order_id to the new SELL order
        await db.execute(
            "UPDATE grid_orders SET binance_order_id=? WHERE id=?",
            (sell_binance_id, order["db_order_id"]),
        )
        await db.commit()

        # Update in-memory: remove old key, add new key for sell order
        del self._orders[binance_buy_id]
        self._orders[sell_binance_id] = {
            **order,
            "side":      "sell",
            "bought_at": ts_ms,
            "buy_fill":  fill_px,
            "qty":       sell_qty,
        }
        logger.info("live_grid:buy_filled", {"level": order["level"], "fill_px": fill_px})

    async def _handle_sell_filled(self, db, binance_sell_id: str, order: dict, fill_px: float, qty: float, ts_ms: int):
        now_ms = int(time.time() * 1000)
        buy_fill = order.get("buy_fill") or fill_px
        fee  = order["order_size"] * CONFIG.grid_fee_pct * 2
        pnl  = round((fill_px - buy_fill) * qty - fee, 6)

        # Close the order row
        await db.execute(
            "UPDATE grid_orders SET status='closed', sell_fill_price=?, sold_at=? WHERE id=?",
            (fill_px, ts_ms, order["db_order_id"]),
        )
        # Record trade
        await db.execute(
            """INSERT INTO grid_trades
               (order_id, buy_price, sell_price, order_size_usd, pnl, fee, opened_at, closed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (order["db_order_id"], buy_fill, fill_px, order["order_size"], pnl, fee,
             order.get("bought_at") or now_ms, ts_ms),
        )
        await db.commit()

        # Place new BUY order to recycle this level
        new_qty = _round_step(order["order_size"] / order["buy_price"], self._step_size)
        new_px  = _round_tick(order["buy_price"], self._tick_size)
        try:
            resp = await place_limit_order(SYMBOL, "BUY", new_qty, new_px)
            new_binance_id = str(resp["orderId"])
        except Exception as e:
            logger.error("live_grid:recycle_buy:error", {"error": str(e)})
            del self._orders[binance_sell_id]
            return

        # New DB row for recycled order
        cur = await db.execute(
            """INSERT INTO grid_orders
               (config_id, level, buy_price, sell_price, order_size, status, binance_order_id)
               VALUES (?, ?, ?, ?, ?, 'pending', ?)""",
            (self._config_id, order["level"], order["buy_price"], order["sell_price"],
             order["order_size"], new_binance_id),
        )
        await db.commit()

        del self._orders[binance_sell_id]
        self._orders[new_binance_id] = {
            "db_order_id":  cur.lastrowid,
            "level":        order["level"],
            "side":         "buy",
            "buy_price":    order["buy_price"],
            "sell_price":   order["sell_price"],
            "order_size":   order["order_size"],
            "qty":          new_qty,
            "bought_at":    None,
            "buy_fill":     None,
        }
        logger.info("live_grid:sell_filled", {"level": order["level"], "fill_px": fill_px, "pnl": pnl})

    def _broadcast(self):
        status = self.get_status()
        for q in self._subscribers[:]:
            try:
                q.put_nowait(status)
            except asyncio.QueueFull:
                pass
