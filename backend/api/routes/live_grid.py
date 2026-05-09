import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.auth import require_token
from config import CONFIG
from db.connection import get_db, fetchall, fetchone
from strategies.live_grid import live_grid_engine


def _query_token(token: str = Query(...)) -> str:
    if token != CONFIG.api_token:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token

router = APIRouter(prefix="/api/live-grid", tags=["live-grid"])


class GridStartRequest(BaseModel):
    grid_min:       float
    grid_max:       float
    levels:         int   = 10
    order_size_pct: float = 0.05


@router.post("/start")
async def start(_: str = Depends(require_token), body: GridStartRequest = ...):
    result = await live_grid_engine.start(
        body.grid_min, body.grid_max, body.levels, body.order_size_pct
    )
    return {"ok": True, **result}


@router.post("/stop")
async def stop(_: str = Depends(require_token)):
    await live_grid_engine.stop()
    return {"ok": True}


@router.get("/status")
async def status(_: str = Depends(require_token)):
    base = live_grid_engine.get_status()
    db   = await get_db("live")

    config_id = live_grid_engine._config_id
    trades = []
    orders = []
    pnl    = 0.0
    wins   = 0

    if config_id:
        trades = await fetchall(db, """
            SELECT gt.id, gt.buy_price, gt.sell_price, gt.order_size_usd, gt.pnl,
                   gt.fee, gt.opened_at, gt.closed_at, go.level
            FROM grid_trades gt JOIN grid_orders go ON gt.order_id = go.id
            WHERE go.config_id = ?
            ORDER BY gt.closed_at DESC LIMIT 100
        """, (config_id,))
        orders = await fetchall(db, """
            SELECT id, level, buy_price, sell_price, order_size, status,
                   buy_fill_price, sell_fill_price, bought_at, sold_at, binance_order_id
            FROM grid_orders WHERE config_id = ? AND status IN ('pending','bought')
            ORDER BY level
        """, (config_id,))
        pnl_row = await fetchone(db, """
            SELECT COALESCE(SUM(gt.pnl),0) AS s, COUNT(*) AS n,
                   SUM(CASE WHEN gt.pnl > 0 THEN 1 ELSE 0 END) AS w
            FROM grid_trades gt JOIN grid_orders go ON gt.order_id = go.id
            WHERE go.config_id = ?
        """, (config_id,))
        pnl  = round((pnl_row or {}).get("s") or 0, 4)
        wins = (pnl_row or {}).get("w") or 0
        cnt  = (pnl_row or {}).get("n") or 0
        win_rate = round(wins / cnt * 100, 1) if cnt else 0
    else:
        win_rate = 0
        cnt = 0

    return {**base, "pnl": pnl, "trade_count": cnt, "win_rate": win_rate,
            "orders": orders, "trades": trades}


@router.get("/stream")
async def stream(token: str = Depends(_query_token)):
    q = live_grid_engine.subscribe()

    async def event_gen():
        try:
            # Send initial state
            yield f"event: init\ndata: {json.dumps(live_grid_engine.get_status())}\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {json.dumps(data)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            live_grid_engine.unsubscribe(q)

    return StreamingResponse(event_gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
