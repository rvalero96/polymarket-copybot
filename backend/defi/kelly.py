"""
Kelly Criterion — sizing dinámico del capital activo vs AAVE.

Fórmula: f* = (p·b − q) / b
  p  = win rate histórico
  q  = 1 − p
  b  = ratio ganancia media / pérdida media (odds)
  f* = fracción óptima del capital total a poner en riesgo

Fases:
  Fase 1 (< MIN_TRADES_PHASE2): sin edge validado → 100% AAVE
  Fase 2 (< MIN_TRADES_PHASE3): half-Kelly (50% del tamaño recomendado)
  Fase 3 (≥ MIN_TRADES_PHASE3): full Kelly — edge validado estadísticamente
"""

import time
import aiosqlite
from config import CONFIG
from db.connection import fetchone, fetchall, execute
from logger import logger


async def compute_kelly_stats(db: aiosqlite.Connection) -> dict:
    copy = await fetchone(db, """
        SELECT
            COUNT(*)                                                 AS total,
            SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)               AS wins,
            AVG(CASE WHEN pnl > 0 THEN pnl      ELSE NULL END)      AS avg_win,
            AVG(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE NULL END)      AS avg_loss
        FROM trades
        WHERE status = 'closed' AND pnl IS NOT NULL
    """)
    btc = await fetchone(db, """
        SELECT
            COUNT(*)                                                 AS total,
            SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)               AS wins,
            AVG(CASE WHEN pnl > 0 THEN pnl      ELSE NULL END)      AS avg_win,
            AVG(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE NULL END)      AS avg_loss
        FROM btc5m_trades
        WHERE status != 'open' AND pnl IS NOT NULL
    """)

    copy_total  = copy["total"]  or 0
    btc_total   = btc["total"]   or 0
    copy_wins   = copy["wins"]   or 0
    btc_wins    = btc["wins"]    or 0

    total = copy_total + btc_total
    wins  = copy_wins  + btc_wins

    copy_loss = copy_total - copy_wins
    btc_loss  = btc_total  - btc_wins
    total_wins = copy_wins + btc_wins
    total_loss = copy_loss + btc_loss

    avg_win = None
    if total_wins > 0:
        avg_win = (
            (copy_wins * (copy["avg_win"] or 0)) +
            (btc_wins  * (btc["avg_win"]  or 0))
        ) / total_wins

    avg_loss = None
    if total_loss > 0:
        avg_loss = (
            (copy_loss * (copy["avg_loss"] or 0)) +
            (btc_loss  * (btc["avg_loss"]  or 0))
        ) / total_loss

    win_rate = wins / total if total > 0 else None
    b = (avg_win / avg_loss) if (avg_win is not None and avg_loss and avg_loss > 0) else None

    return {
        "total": total, "wins": wins,
        "avg_win": avg_win, "avg_loss": avg_loss,
        "win_rate": win_rate, "b": b,
        "copy": copy, "btc": btc,
    }


def get_kelly_phase(total_trades: int) -> int:
    if total_trades < CONFIG.min_trades_phase2:
        return 1
    if total_trades < CONFIG.min_trades_phase3:
        return 2
    return 3


def kelly_fraction(p: float, b: float) -> float:
    if not p or not b or b <= 0:
        return 0.0
    q = 1 - p
    return max(0.0, (p * b - q) / b)


async def get_kelly_allocation(db: aiosqlite.Connection, portfolio: float) -> dict:
    stats = await compute_kelly_stats(db)
    phase = get_kelly_phase(stats["total"])

    if phase == 1 or stats["win_rate"] is None or stats["b"] is None:
        result = {
            "phase": 1,
            "trading_fraction": 0.0,
            "aave_fraction": 1.0,
            "trading_budget": 0.0,
            "aave_budget": portfolio,
            "raw_kelly": 0.0,
            "multiplier": 0.0,
            "position_size": 0.0,
            "stats": stats,
        }
        logger.info("kelly:phase1", {
            "total_trades": stats["total"],
            "needed": CONFIG.min_trades_phase2,
            "note": "accumulating edge data — 100% AAVE",
        })
        return result

    raw_kelly  = kelly_fraction(stats["win_rate"], stats["b"])
    multiplier = CONFIG.half_kelly_mult if phase == 2 else 1.0
    fraction   = min(raw_kelly * multiplier, CONFIG.max_kelly_fraction)

    trading_budget = portfolio * fraction
    aave_budget    = portfolio * (1 - fraction)
    position_size  = trading_budget / CONFIG.positions_in_budget

    result = {
        "phase": phase,
        "trading_fraction": fraction,
        "aave_fraction": 1 - fraction,
        "trading_budget": trading_budget,
        "aave_budget": aave_budget,
        "raw_kelly": raw_kelly,
        "multiplier": multiplier,
        "position_size": position_size,
        "stats": stats,
    }

    logger.info("kelly:allocation", {
        "phase": phase,
        "p": f"{stats['win_rate']:.4f}",
        "b": f"{stats['b']:.4f}",
        "raw_kelly": f"{raw_kelly * 100:.2f}%",
        "multiplier": multiplier,
        "fraction": f"{fraction * 100:.2f}%",
        "trading_budget": f"{trading_budget:.2f}",
        "aave_budget": f"{aave_budget:.2f}",
        "position_size": f"{position_size:.2f}",
    })
    return result


async def save_kelly_snapshot(db: aiosqlite.Connection, portfolio: float, allocation: dict) -> None:
    stats = allocation["stats"]
    await execute(db, """
        INSERT INTO kelly_snapshots
            (portfolio, phase, raw_kelly, multiplier, fraction, trading_budget,
             aave_budget, position_size, win_rate, odds_b, total_trades, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        portfolio,
        allocation["phase"],
        allocation["raw_kelly"],
        allocation["multiplier"],
        allocation["trading_fraction"],
        allocation["trading_budget"],
        allocation["aave_budget"],
        allocation["position_size"],
        stats.get("win_rate"),
        stats.get("b"),
        stats["total"],
        int(time.time() * 1000),
    ))


async def get_kelly_history(db: aiosqlite.Connection, limit: int = 200) -> list:
    return await fetchall(db,
        "SELECT * FROM kelly_snapshots ORDER BY created_at DESC LIMIT ?",
        (limit,)
    )
