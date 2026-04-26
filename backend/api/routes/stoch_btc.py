import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.auth import require_token
from config import CONFIG
from strategies.stoch_btc import stoch_btc_engine

router = APIRouter(prefix="/api/stoch-btc", tags=["stoch_btc"])


class StochStartRequest(BaseModel):
    k_period:       int   = Field(default=14,   ge=2,  le=200)
    d_period:       int   = Field(default=3,    ge=1,  le=50)
    candle_tf:      str   = Field(default="5m")
    order_size_pct: float = Field(default=0.05, gt=0,  lt=1.0)


def _query_token(token: str = Query(...)) -> str:
    if token != CONFIG.api_token:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token


@router.get("/stream")
async def stoch_stream(token: str = Depends(_query_token)):
    async def generate():
        q = stoch_btc_engine.subscribe()
        try:
            init_data = json.dumps(await stoch_btc_engine.get_status())
            yield f"event: init\ndata: {init_data}\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=20.0)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            stoch_btc_engine.unsubscribe(q)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


@router.get("/status")
async def get_stoch_status(_: str = Depends(require_token)):
    return await stoch_btc_engine.get_status()


@router.post("/start")
async def start_stoch(req: StochStartRequest, _: str = Depends(require_token)):
    return await stoch_btc_engine.start(req.k_period, req.d_period, req.candle_tf, req.order_size_pct)


@router.post("/stop")
async def stop_stoch(_: str = Depends(require_token)):
    await stoch_btc_engine.stop()
    return {"ok": True}
