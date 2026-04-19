from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from api.auth import require_token
from strategies.grid import grid_engine

router = APIRouter(prefix="/api/grid", tags=["grid"])


class GridStartRequest(BaseModel):
    grid_min:   float = Field(default=80000.0, gt=0)
    grid_max:   float = Field(default=90000.0, gt=0)
    levels:     int   = Field(default=10, ge=2, le=200)
    order_size: float = Field(default=50.0, gt=0)


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
