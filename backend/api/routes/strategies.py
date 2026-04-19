from fastapi import APIRouter, Depends, HTTPException
from api.auth import require_token

router = APIRouter(prefix="/api/strategies", tags=["strategies"])

# Referencia a las instancias de estrategias (se inyecta desde main.py)
_strategies: list = []


def set_strategies(strategies: list) -> None:
    global _strategies
    _strategies = strategies


@router.get("")
async def list_strategies(_: str = Depends(require_token)):
    return [
        {
            "name": s.name,
            "enabled": s.enabled,
            "schedule": s.get_schedule(),
        }
        for s in _strategies
    ]


@router.post("/{name}/enable")
async def enable_strategy(name: str, _: str = Depends(require_token)):
    strategy = next((s for s in _strategies if s.name == name), None)
    if not strategy:
        raise HTTPException(status_code=404, detail=f"Strategy '{name}' not found")
    strategy.enabled = True
    return {"name": name, "enabled": True}


@router.post("/{name}/disable")
async def disable_strategy(name: str, _: str = Depends(require_token)):
    strategy = next((s for s in _strategies if s.name == name), None)
    if not strategy:
        raise HTTPException(status_code=404, detail=f"Strategy '{name}' not found")
    strategy.enabled = False
    return {"name": name, "enabled": False}


@router.post("/{name}/run")
async def run_strategy_now(name: str, _: str = Depends(require_token)):
    strategy = next((s for s in _strategies if s.name == name), None)
    if not strategy:
        raise HTTPException(status_code=404, detail=f"Strategy '{name}' not found")
    await strategy.run()
    return {"name": name, "status": "executed"}
