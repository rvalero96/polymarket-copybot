import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.auth import require_token
from config import CONFIG
from strategies.grid_pepe import pepe_grid_engine

router = APIRouter(prefix="/api/grid-pepe", tags=["grid-pepe"])


class PepeGridStartRequest(BaseModel):
    order_size_pct: float = Field(default=0.05,  gt=0, lt=1.0)
    ma_type:        str   = Field(default="EMA")          # SMA | EMA | VWMA | TEMA | LREG
    ma_period:      int   = Field(default=20,    ge=5, le=200)
    interval_pct:   float = Field(default=0.02,  gt=0, lt=0.5)
    laziness_pct:   float = Field(default=0.015, gt=0, lt=0.5)


def _query_token(token: str = Query(...)) -> str:
    """Auth via query param — needed for EventSource (no custom headers in browser)."""
    if token != CONFIG.api_token:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token


@router.get("/stream")
async def pepe_grid_stream(token: str = Depends(_query_token)):
    """SSE endpoint — pushes full status on every fill, anchor update, start, or stop."""
    async def generate():
        q = pepe_grid_engine.subscribe()
        try:
            init_data = json.dumps(await pepe_grid_engine.get_status())
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
            pepe_grid_engine.unsubscribe(q)

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
async def get_pepe_grid_status(_: str = Depends(require_token)):
    return await pepe_grid_engine.get_status()


@router.post("/start")
async def start_pepe_grid(req: PepeGridStartRequest, _: str = Depends(require_token)):
    return await pepe_grid_engine.start(
        req.order_size_pct, req.ma_type, req.ma_period, req.interval_pct, req.laziness_pct
    )


@router.post("/stop")
async def stop_pepe_grid(_: str = Depends(require_token)):
    await pepe_grid_engine.stop()
    return {"ok": True}
