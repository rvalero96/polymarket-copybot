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
from api.routes.grid_pepe import router as grid_pepe_router
from api.routes.stoch_btc import router as stoch_btc_router
from api.routes.reset import router as reset_router
from strategies.grid import grid_engine
from strategies.grid_pepe import pepe_grid_engine
from strategies.stoch_btc import stoch_btc_engine
from logger import logger

# ── Instancias de estrategias ─────────────────────────────────────────────────
# Only Kelly is enabled by default; grids are started manually from the UI.
# Copy trading, discovery, 5m, arbitrage and AAVE are disabled until turned on.

_discovery = DiscoveryStrategy(); _discovery.enabled = False
_copy      = CopyTradingStrategy(); _copy.enabled = False
_btc5m     = Btc5mStrategy();  _btc5m.enabled = False
_arb       = ArbitrageStrategy(); _arb.enabled = False
_kelly     = KellyStrategy()   # enabled by default
_aave      = AaveStrategy();   _aave.enabled = False

STRATEGIES = [_discovery, _copy, _btc5m, _arb, _kelly, _aave]

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
    import time as _time
    # Inicializar DB
    from db.connection import get_db
    import time as _time
    db = await get_db()
    logger.info("app:db:ready")

    # Clean up stale 'running' state left by any ungraceful previous shutdown
    _now_ms = int(_time.time() * 1000)
    await db.execute(
        "UPDATE pepe_grid_config SET status='stopped', updated_at=? WHERE status='running'",
        (_now_ms,)
    )
    await db.execute(
        "UPDATE grid_config SET status='stopped', updated_at=? WHERE status='running'",
        (_now_ms,)
    )
    await db.execute(
        "UPDATE stoch_btc_config SET status='stopped', updated_at=? WHERE status='running'",
        (_now_ms,)
    )
    await db.commit()
    logger.info("app:startup:stale_configs_cleared")

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
    await pepe_grid_engine.stop()
    await stoch_btc_engine.stop()
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
app.include_router(grid_pepe_router)
app.include_router(stoch_btc_router)
app.include_router(reset_router)

# Inyectar instancias de estrategias en el router de strategies
set_strategies(STRATEGIES)

# Frontend estático (un nivel arriba de backend/)
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
