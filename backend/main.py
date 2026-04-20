"""
TradeBot — Backend
FastAPI + APScheduler
"""

import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from strategies.copy_trading import CopyTradingStrategy, DiscoveryStrategy
from strategies.btc5m import Btc5mStrategy
from strategies.arbitrage import ArbitrageStrategy
from strategies.aave import KellyStrategy, AaveStrategy
from api.routes import dashboard, positions, trades, strategies as strategies_router
from api.routes.strategies import set_strategies
from api.routes.grid import router as grid_router
from strategies.grid import grid_engine
from logger import logger

# ── Instancias de estrategias ─────────────────────────────────────────────────

STRATEGIES = [
    DiscoveryStrategy(),
    CopyTradingStrategy(),
    Btc5mStrategy(),
    ArbitrageStrategy(),
    KellyStrategy(),
    AaveStrategy(),
]

# ── Scheduler ─────────────────────────────────────────────────────────────────

scheduler = AsyncIOScheduler(timezone="UTC")


def _parse_cron(expr: str) -> dict:
    """Convierte un cron expression a kwargs de CronTrigger."""
    parts = expr.strip().split()
    keys  = ["minute", "hour", "day", "month", "day_of_week"]
    return dict(zip(keys, parts))


async def _safe_run(strategy):
    if not strategy.enabled:
        return
    try:
        await asyncio.shield(strategy.run())
    except asyncio.CancelledError:
        logger.warn(f"scheduler:{strategy.name}:cancelled")
    except Exception as err:
        logger.error(f"scheduler:{strategy.name}:error", {"error": str(err)})


# ── App lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Inicializar DB
    from db.connection import get_db
    await get_db()
    logger.info("app:db:ready")

    # Registrar estrategias en el scheduler
    for strategy in STRATEGIES:
        cron_kwargs = _parse_cron(strategy.get_schedule())
        scheduler.add_job(
            _safe_run,
            CronTrigger(**cron_kwargs),
            args=[strategy],
            id=strategy.name,
            replace_existing=True,
        )
        logger.info(f"scheduler:registered", {"strategy": strategy.name, "schedule": strategy.get_schedule()})

    scheduler.start()
    logger.info("app:scheduler:started")

    yield

    await grid_engine.stop()
    scheduler.shutdown()
    logger.info("app:shutdown")


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="TradeBot",
    version="2.0.0",
    lifespan=lifespan,
)

# API routes
app.include_router(dashboard.router)
app.include_router(positions.router)
app.include_router(trades.router)
app.include_router(strategies_router.router)
app.include_router(grid_router)

# Inyectar instancias de estrategias en el router de strategies
set_strategies(STRATEGIES)

# Frontend estático (un nivel arriba de backend/)
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
