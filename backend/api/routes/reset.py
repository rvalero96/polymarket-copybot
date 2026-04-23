import time
import datetime

from fastapi import APIRouter, Depends
from api.auth import require_token
from config import CONFIG
from db.connection import get_db

router = APIRouter(prefix="/api/reset", tags=["reset"])

# Imported lazily inside handler to avoid circular imports at module load time

# Tables to wipe completely (order matters for FK constraints)
_WIPE_TABLES = [
    "pepe_grid_trades",
    "pepe_grid_orders",
    "pepe_grid_config",
    "grid_trades",
    "grid_orders",
    "grid_config",
    "arb_trades",
    "arb_opportunities",
    "arb_groups",
    "btc5m_trades",
    "btc5m_positions",
    "trades",
    "positions",
    "signals",
    "kelly_snapshots",
    "aave_yields",
    "snapshots",
]

# Strategies that are enabled after reset
_ENABLED_AFTER_RESET = {"kelly"}


@router.post("")
async def reset_all(_: str = Depends(require_token)):
    """
    Wipes all trade/position/snapshot data and seeds a fresh $1 000 bankroll.
    Returns the list of tables cleared and the new snapshot.
    """
    from api.routes.strategies import _strategies  # live list from main.py
    from strategies.grid import grid_engine
    from strategies.grid_pepe import pepe_grid_engine

    # 0. Stop grid engines first so they release in-memory state and DB references
    await grid_engine.stop()
    await pepe_grid_engine.stop()

    db = await get_db()

    # 1. Wipe all data tables
    for tbl in _WIPE_TABLES:
        await db.execute(f"DELETE FROM {tbl}")

    # 2. Seed fresh snapshot with initial bankroll
    bankroll  = CONFIG.paper_bankroll          # 1000.0
    today     = datetime.date.today().isoformat()
    now_ms    = int(time.time() * 1000)
    await db.execute(
        """INSERT OR REPLACE INTO snapshots
           (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
           VALUES (?, ?, 0, 0, 0, 0, ?)""",
        (today, bankroll, now_ms),
    )

    await db.commit()

    # 3. Apply default enabled/disabled to running strategy instances
    toggled = {}
    for s in _strategies:
        should_enable = s.name in _ENABLED_AFTER_RESET
        s.enabled = should_enable
        toggled[s.name] = should_enable

    return {
        "ok":        True,
        "bankroll":  bankroll,
        "snapshot":  today,
        "cleared":   _WIPE_TABLES,
        "strategies": toggled,
    }
