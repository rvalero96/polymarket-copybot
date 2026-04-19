import asyncio
import json
import time

import websockets

from config import CONFIG
from db.connection import get_db, fetchall, fetchone
from logger import logger


class GridEngine:
    def __init__(self):
        self._task: asyncio.Task | None = None
        self._price: float | None = None
        self._price_history: list[dict] = []   # [{time: unix_s, value: float}]
        self._max_history = 600
        self.running = False
        self._config_id: int | None = None
        self._pending: dict[int, dict] = {}    # oid -> order (in-memory, hot path)
        self._bought: dict[int, dict] = {}
        self._last_check = 0.0
        self._check_interval = 0.15
        self._subscribers: list[asyncio.Queue] = []

    @property
    def current_price(self) -> float | None:
        return self._price

    # ── Pub/sub for SSE clients ────────────────────────────────────────────────

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
                dead.append(q)   # slow client — drop it
        for q in dead:
            self.unsubscribe(q)

    # ── Public API ─────────────────────────────────────────────────────────────

    async def start(self, grid_min: float, grid_max: float, levels: int, order_size: float) -> dict:
        if self.running:
            return {"ok": False, "error": "Grid already running"}
        if grid_min >= grid_max:
            return {"ok": False, "error": "grid_min must be less than grid_max"}
        if levels < 2 or levels > 200:
            return {"ok": False, "error": "levels must be between 2 and 200"}

        db = await get_db()

        await db.execute(
            "UPDATE grid_config SET status='stopped', updated_at=? WHERE status='running'",
            (int(time.time() * 1000),)
        )

        now_ms = int(time.time() * 1000)
        async with db.execute(
            "INSERT INTO grid_config (grid_min, grid_max, levels, order_size, status, created_at, updated_at) VALUES (?,?,?,?,'running',?,?)",
            (grid_min, grid_max, levels, order_size, now_ms, now_ms)
        ) as cur:
            config_id = cur.lastrowid
        await db.commit()

        self._config_id = config_id
        self._pending.clear()
        self._bought.clear()

        spacing = (grid_max - grid_min) / levels
        for i in range(levels):
            buy_price  = round(grid_min + i * spacing, 2)
            sell_price = round(buy_price + spacing, 2)
            async with db.execute(
                "INSERT INTO grid_orders (config_id, level, buy_price, sell_price, order_size, status) VALUES (?,?,?,?,?,'pending')",
                (config_id, i, buy_price, sell_price, order_size)
            ) as cur:
                oid = cur.lastrowid
            self._pending[oid] = {
                "id": oid, "config_id": config_id, "level": i,
                "buy_price": buy_price, "sell_price": sell_price, "order_size": order_size,
            }
        await db.commit()

        self.running = True
        self._task = asyncio.create_task(self._ws_loop())
        logger.info("grid:started", {"config_id": config_id, "levels": levels, "min": grid_min, "max": grid_max})
        asyncio.create_task(self._broadcast())
        return {"ok": True, "config_id": config_id}

    async def stop(self) -> None:
        if not self.running:
            return
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        db = await get_db()
        await db.execute(
            "UPDATE grid_config SET status='stopped', updated_at=? WHERE id=?",
            (int(time.time() * 1000), self._config_id)
        )
        await db.commit()
        logger.info("grid:stopped")
        await self._broadcast()

    async def get_status(self) -> dict:
        db = await get_db()
        config = await fetchone(db, "SELECT * FROM grid_config ORDER BY id DESC LIMIT 1")

        if not config:
            return {"status": "not_configured", "current_price": self._price}

        trades = await fetchall(db, """
            SELECT gt.id, gt.buy_price, gt.sell_price, gt.order_size_usd, gt.pnl, gt.fee, gt.opened_at, gt.closed_at,
                   go.level
            FROM grid_trades gt
            JOIN grid_orders go ON gt.order_id = go.id
            WHERE go.config_id = ?
            ORDER BY gt.closed_at DESC
            LIMIT 100
        """, (config["id"],))

        total_pnl = sum(t["pnl"] for t in trades)
        wins      = sum(1 for t in trades if t["pnl"] > 0)
        win_rate  = round(wins / len(trades) * 100, 1) if trades else 0

        if self.running and self._config_id == config["id"]:
            active_orders = sorted(
                [{**o, "status": "pending"} for o in self._pending.values()] +
                [{**o, "status": "bought"}  for o in self._bought.values()],
                key=lambda x: x["level"]
            )
        else:
            active_orders = await fetchall(db, """
                SELECT * FROM grid_orders
                WHERE config_id=? AND status IN ('pending','bought')
                ORDER BY level ASC
            """, (config["id"],))

        spacing = round((config["grid_max"] - config["grid_min"]) / config["levels"], 2) if config["levels"] else 0

        return {
            "status":        "running" if self.running else config["status"],
            "current_price": self._price,
            "grid_min":      config["grid_min"],
            "grid_max":      config["grid_max"],
            "levels":        config["levels"],
            "order_size":    config["order_size"],
            "spacing":       spacing,
            "out_of_range":  (
                self._price is not None and
                (self._price < config["grid_min"] or self._price > config["grid_max"])
            ),
            "metrics": {
                "total_pnl":      round(total_pnl, 4),
                "trade_count":    len(trades),
                "win_rate":       win_rate,
                "pending_orders": len([o for o in active_orders if o["status"] == "pending"]),
                "bought_orders":  len([o for o in active_orders if o["status"] == "bought"]),
            },
            "orders":        active_orders,
            "recent_trades": trades[:50],
        }

    # ── WebSocket loop ─────────────────────────────────────────────────────────

    async def _ws_loop(self):
        while self.running:
            try:
                async with websockets.connect(CONFIG.grid_ws_url, ping_interval=20) as ws:
                    logger.info("grid:ws:connected")
                    async for raw in ws:
                        if not self.running:
                            break
                        msg   = json.loads(raw)
                        price = float(msg["p"])
                        ts_ms = int(msg["T"])
                        ts_s  = ts_ms // 1000
                        self._price = price
                        if not self._price_history or self._price_history[-1]["time"] != ts_s:
                            self._price_history.append({"time": ts_s, "value": price})
                            if len(self._price_history) > self._max_history:
                                self._price_history.pop(0)
                        await self._check_fills(price, ts_ms)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("grid:ws:error", {"error": str(exc)})
                if self.running:
                    await asyncio.sleep(5)

    # ── Fill detection (in-memory hot path, DB writes only on fills) ───────────

    async def _check_fills(self, price: float, ts_ms: int):
        now = time.monotonic()
        if now - self._last_check < self._check_interval:
            return
        self._last_check = now

        to_buy  = [(oid, o) for oid, o in list(self._pending.items()) if price <= o["buy_price"]]
        to_sell = [(oid, o) for oid, o in list(self._bought.items())  if price >= o["sell_price"]]

        if not to_buy and not to_sell:
            return

        db = await get_db()

        for oid, order in to_buy:
            order["buy_fill_price"] = price
            order["bought_at"]      = ts_ms
            self._bought[oid]       = order
            del self._pending[oid]
            await db.execute(
                "UPDATE grid_orders SET status='bought', bought_at=?, buy_fill_price=? WHERE id=?",
                (ts_ms, price, oid)
            )
            logger.info("grid:buy:filled", {"level": order["level"], "price": price})

        for oid, order in to_sell:
            fee = order["order_size"] * CONFIG.grid_fee_pct * 2
            pnl = round(
                (order["order_size"] / order["buy_fill_price"]) * (price - order["buy_fill_price"]) - fee,
                4
            )
            await db.execute(
                "UPDATE grid_orders SET status='closed', sold_at=?, sell_fill_price=? WHERE id=?",
                (ts_ms, price, oid)
            )
            await db.execute(
                """INSERT INTO grid_trades
                   (order_id, buy_price, sell_price, order_size_usd, pnl, fee, opened_at, closed_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (oid, order["buy_fill_price"], price, order["order_size"], pnl, round(fee, 4), order["bought_at"], ts_ms)
            )
            async with db.execute(
                "INSERT INTO grid_orders (config_id, level, buy_price, sell_price, order_size, status) VALUES (?,?,?,?,?,'pending')",
                (order["config_id"], order["level"], order["buy_price"], order["sell_price"], order["order_size"])
            ) as cur:
                new_id = cur.lastrowid

            del self._bought[oid]
            self._pending[new_id] = {
                "id": new_id, "config_id": order["config_id"], "level": order["level"],
                "buy_price": order["buy_price"], "sell_price": order["sell_price"],
                "order_size": order["order_size"],
            }
            logger.info("grid:sell:filled", {"level": order["level"], "price": price, "pnl": pnl})

        await db.commit()
        asyncio.create_task(self._broadcast())


grid_engine = GridEngine()
