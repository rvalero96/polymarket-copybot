import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.auth import require_token
from config import CONFIG
from db.connection import get_db, fetchall, fetchone
from strategies.live_grid_pepe import live_pepe_grid_engine


def _query_token(token: str = Query(...)) -> str:
    if token != CONFIG.api_token:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token

router = APIRouter(prefix="/api/live-grid-pepe", tags=["live-grid-pepe"])


class PepeGridStartRequest(BaseModel):
    order_size_pct: float = 0.05
    ma_type:        str   = "EMA"
    ma_period:      int   = 20
    interval_pct:   float = 0.02
    laziness_pct:   float = 0.015


@router.post("/start")
async def start(_: str = Depends(require_token), body: PepeGridStartRequest = ...):
    result = await live_pepe_grid_engine.start(
        body.order_size_pct, body.ma_type, body.ma_period,
        body.interval_pct, body.laziness_pct,
    )
    return {"ok": True, **result}


@router.post("/stop")
async def stop(_: str = Depends(require_token)):
    await live_pepe_grid_engine.stop()
    return {"ok": True}


@router.get("/status")
async def status(_: str = Depends(require_token)):
    base      = live_pepe_grid_engine.get_status()
    db        = await get_db("live")
    config_id = live_pepe_grid_engine._config_id

    trades = []
    orders = []
    pnl    = 0.0
    cnt    = 0
    win_rate = 0.0

    if config_id:
        trades = await fetchall(db, """
            SELECT pt.id, pt.level_index, pt.grid_epoch, pt.buy_price, pt.sell_price,
                   pt.order_size_usd, pt.pnl, pt.fee, pt.anchor_at_trade, pt.opened_at, pt.closed_at
            FROM pepe_grid_trades pt
            JOIN pepe_grid_orders po ON pt.order_id = po.id
            WHERE po.config_id = ?
            ORDER BY pt.closed_at DESC LIMIT 100
        """, (config_id,))
        orders = await fetchall(db, """
            SELECT id, level_index, grid_epoch, buy_price, sell_price, order_size, status,
                   buy_fill_price, sell_fill_price, bought_at, sold_at, binance_order_id
            FROM pepe_grid_orders WHERE config_id = ? AND status IN ('pending','bought')
            ORDER BY level_index
        """, (config_id,))
        row = await fetchone(db, """
            SELECT COALESCE(SUM(pt.pnl),0) AS s, COUNT(*) AS n,
                   SUM(CASE WHEN pt.pnl > 0 THEN 1 ELSE 0 END) AS w
            FROM pepe_grid_trades pt
            JOIN pepe_grid_orders po ON pt.order_id = po.id
            WHERE po.config_id = ?
        """, (config_id,))
        pnl  = round((row or {}).get("s") or 0, 10)
        cnt  = (row or {}).get("n") or 0
        wins = (row or {}).get("w") or 0
        win_rate = round(wins / cnt * 100, 1) if cnt else 0

    return {**base, "pnl": pnl, "trade_count": cnt, "win_rate": win_rate,
            "orders": orders, "trades": trades}


@router.get("/stream")
async def stream(token: str = Depends(_query_token)):
    q = live_pepe_grid_engine.subscribe()

    async def event_gen():
        try:
            yield f"event: init\ndata: {json.dumps(live_pepe_grid_engine.get_status())}\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            live_pepe_grid_engine.unsubscribe(q)

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
