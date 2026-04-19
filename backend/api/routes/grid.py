import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.auth import require_token
from config import CONFIG
from strategies.grid import grid_engine

router = APIRouter(prefix="/api/grid", tags=["grid"])


class GridStartRequest(BaseModel):
    grid_min:   float = Field(default=80000.0, gt=0)
    grid_max:   float = Field(default=90000.0, gt=0)
    levels:     int   = Field(default=10, ge=2, le=200)
    order_size: float = Field(default=50.0, gt=0)


def _query_token(token: str = Query(...)) -> str:
    """Auth via query param — needed for EventSource (no custom headers in browser)."""
    if token != CONFIG.api_token:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token


@router.get("/stream")
async def grid_stream(token: str = Depends(_query_token)):
    """SSE endpoint — pushes full status on every fill, start, or stop event."""
    async def generate():
        q = grid_engine.subscribe()
        try:
            # Send initial state immediately on connect
            init_data = json.dumps(await grid_engine.get_status())
            yield f"event: init\ndata: {init_data}\n\n"

            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=20.0)
                    yield f"data: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"   # keeps the connection alive through proxies
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            grid_engine.unsubscribe(q)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering
            "Connection":       "keep-alive",
        },
    )


@router.get("/status")
async def get_grid_status(_: str = Depends(require_token)):
    return await grid_engine.get_status()


@router.post("/start")
async def start_grid(req: GridStartRequest, _: str = Depends(require_token)):
    return await grid_engine.start(req.grid_min, req.grid_max, req.levels, req.order_size)


@router.post("/stop")
async def stop_grid(_: str = Depends(require_token)):
    await grid_engine.stop()
    return {"ok": True}
