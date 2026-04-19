"""
AAVE v3 Polygon — yield simulation for idle USDC.

En paper-trading mode: obtiene el APY real de USDC desde DefiLlama
y acumula el interés equivalente sobre el idle bankroll cada ciclo.
"""

import time
import httpx
import aiosqlite
from config import CONFIG
from db.connection import fetchone, execute
from logger import logger


async def fetch_usdc_supply_apy() -> float:
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(CONFIG.defillama_pools_api)
            if resp.status_code == 200:
                data = resp.json().get("data", [])

                # Primero buscar por pool ID estable
                pool = next((p for p in data if p.get("pool") == CONFIG.aave_v3_polygon_usdc_pool), None)

                if not pool:
                    # Fallback: mayor TVL entre pools AAVE v3 Polygon USDC
                    candidates = [
                        p for p in data
                        if p.get("project") == "aave-v3"
                        and p.get("chain") == "Polygon"
                        and p.get("symbol") in ("USDC", "USDC.E")
                    ]
                    candidates.sort(key=lambda p: p.get("tvlUsd") or 0, reverse=True)
                    pool = candidates[0] if candidates else None

                if pool and pool.get("apy") is not None:
                    apy = pool["apy"] / 100  # DefiLlama retorna % (ej: 1.81)
                    if 0 < apy < 1:
                        logger.info("aave:apy-fetched", {
                            "source": "defillama",
                            "pool": pool.get("pool"),
                            "symbol": pool.get("symbol"),
                            "tvl": pool.get("tvlUsd"),
                            "apy": f"{apy * 100:.2f}%",
                        })
                        return apy
    except Exception:
        pass

    fallback = CONFIG.aave_fallback_apy
    logger.warn("aave:apy-fallback", {"apy": f"{fallback * 100:.2f}%"})
    return fallback


async def apply_aave_yield(db: aiosqlite.Connection, bankroll: float) -> float:
    now_ms = int(time.time() * 1000)

    if bankroll < CONFIG.aave_min_idle_usdc:
        logger.info("aave:yield-skipped", {"reason": "bankroll too low", "bankroll": bankroll})
        return bankroll

    last_yield = await fetchone(db, "SELECT created_at FROM aave_yields ORDER BY created_at DESC LIMIT 1")
    last_at    = last_yield["created_at"] if last_yield else (now_ms - 2 * 3_600_000)
    hours_raw  = (now_ms - last_at) / 3_600_000
    hours      = min(hours_raw, CONFIG.aave_max_yield_hours)

    if hours_raw < 0.5:
        logger.info("aave:yield-skipped", {"reason": "too soon", "hours_elapsed": f"{hours_raw:.2f}"})
        return bankroll

    apy          = await fetch_usdc_supply_apy()
    hourly_rate  = apy / (365 * 24)
    yield_earned = bankroll * hourly_rate * hours

    await execute(db,
        "INSERT INTO aave_yields (amount, apy, idle_cash, hours, created_at) VALUES (?, ?, ?, ?, ?)",
        (yield_earned, apy, bankroll, hours, now_ms),
    )

    logger.info("aave:yield-applied", {
        "amount": f"+{yield_earned:.4f} USDC",
        "apy": f"{apy * 100:.2f}%",
        "idle_cash": f"{bankroll:.2f}",
        "hours": f"{hours:.2f}",
    })

    return bankroll + yield_earned


async def get_aave_stats(db: aiosqlite.Connection) -> dict:
    from datetime import date
    today = date.today().isoformat()

    total = await fetchone(db, """
        SELECT COALESCE(SUM(amount), 0) AS total,
               COALESCE(AVG(apy), 0)   AS avg_apy
        FROM aave_yields
    """)

    today_row = await fetchone(db, """
        SELECT COALESCE(SUM(amount), 0) AS amount
        FROM aave_yields
        WHERE date(created_at/1000, 'unixepoch') = ?
    """, (today,))

    return {
        "total_yield": total["total"],
        "avg_apy": total["avg_apy"],
        "today_yield": today_row["amount"],
    }
