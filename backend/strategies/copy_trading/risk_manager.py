"""
Risk Manager — controles de riesgo por posición para copy trading.

Cierra posiciones que superen:
  1. TTL:        edad > MAX_POSITION_AGE_DAYS
  2. Stop-loss:  precio actual < precio entrada × (1 − STOP_LOSS_PCT)
  3. Inactividad: precio no se ha movido ≥ INACTIVITY_THRESHOLD_PCT en INACTIVITY_DAYS días
"""

import time
import json
import aiosqlite
from config import CONFIG
from db.connection import fetchall, execute
from services.polymarket import get_market
from logger import logger


def _get_current_price(market: dict, outcome: str) -> float | None:
    try:
        outcomes = json.loads(market.get("outcomes") or "[]") if isinstance(market.get("outcomes"), str) else (market.get("outcomes") or [])
        prices   = json.loads(market.get("outcomePrices") or "[]") if isinstance(market.get("outcomePrices"), str) else (market.get("outcomePrices") or [])
        idx = next((i for i, o in enumerate(outcomes) if o.lower() == outcome.lower()), -1)
        return float(prices[idx]) if idx >= 0 else None
    except Exception:
        return None


async def _force_close(
    db: aiosqlite.Connection,
    pos: dict,
    bankroll: float,
    reason: str,
    close_price: float | None,
) -> float:
    price = close_price if close_price is not None else pos["avg_price"]
    pnl   = pos["size_usdc"] * (price - pos["avg_price"]) / pos["avg_price"]
    fee   = pos["size_usdc"] * CONFIG.fee_pct

    await execute(db,
        "UPDATE trades SET status = 'closed', pnl = ?, close_reason = ? WHERE market_id = ? AND outcome = ? AND status = 'open'",
        (pnl - fee, reason, pos["market_id"], pos["outcome"]),
    )
    await execute(db,
        "DELETE FROM positions WHERE market_id = ? AND outcome = ? AND wallet = ?",
        (pos["market_id"], pos["outcome"], pos["wallet"]),
    )

    logger.info("risk-manager:closed", {
        "reason": reason,
        "market": pos["market_id"],
        "outcome": pos["outcome"],
        "entry": pos["avg_price"],
        "close": price,
        "pnl": f"{pnl - fee:.4f}",
    })

    return bankroll + pos["size_usdc"] + pnl - fee


async def check_position_risks(db: aiosqlite.Connection, bankroll: float) -> float:
    positions = await fetchall(db, "SELECT * FROM positions")
    if not positions:
        return bankroll

    now    = int(time.time() * 1000)
    closed = 0

    for pos in positions:
        try:
            # 1. TTL
            age_days = (now - pos["opened_at"]) / 86_400_000
            if age_days > CONFIG.max_position_age_days:
                market      = await get_market(pos["market_id"])
                close_price = _get_current_price(market, pos["outcome"]) if market else None
                bankroll    = await _force_close(db, pos, bankroll, "ttl", close_price)
                closed += 1
                continue

            # Fetch live price para SL + inactividad
            market = await get_market(pos["market_id"])
            if not market:
                continue

            current_price = _get_current_price(market, pos["outcome"])
            if current_price is None:
                continue

            # 2. Stop-loss
            if current_price < pos["avg_price"] * (1 - CONFIG.stop_loss_pct):
                bankroll = await _force_close(db, pos, bankroll, "stop-loss", current_price)
                closed += 1
                continue

            # 3. Inactividad
            last_price = pos.get("last_price") or pos["avg_price"]
            tracked_at = pos.get("price_tracked_at") or pos["opened_at"]
            price_move = abs(current_price - last_price) / last_price if last_price else 0

            if price_move >= CONFIG.inactivity_threshold_pct:
                await execute(db,
                    "UPDATE positions SET last_price = ?, price_tracked_at = ? WHERE market_id = ? AND outcome = ? AND wallet = ?",
                    (current_price, now, pos["market_id"], pos["outcome"], pos["wallet"]),
                )
            else:
                stale_days = (now - tracked_at) / 86_400_000
                if stale_days > CONFIG.inactivity_days:
                    bankroll = await _force_close(db, pos, bankroll, "inactivity", current_price)
                    closed += 1

        except Exception as err:
            logger.error("risk-manager:error", {"market": pos["market_id"], "error": str(err)})

    logger.info("risk-manager:scan", {"checked": len(positions), "closed": closed})
    return bankroll
