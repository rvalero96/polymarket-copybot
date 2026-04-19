"""
Signals — detecta cambios en las posiciones de las wallets monitorizadas.
"""

import time
import aiosqlite
from config import CONFIG
from db.connection import fetchall, fetchone, execute
from services.polymarket import get_wallet_positions, get_market
from logger import logger


def _should_filter(pos: dict) -> bool:
    price = pos.get("curPrice") or pos.get("currentPrice") or 0
    return price < CONFIG.min_signal_price or price > CONFIG.max_signal_price


async def _fetch_market_end_date(condition_id: str) -> int | None:
    try:
        market = await get_market(condition_id)
        if not market:
            return None
        raw = market.get("endDateIso") or market.get("endDate")
        if not raw:
            return None
        from datetime import datetime
        ts = int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() * 1000)
        return ts
    except Exception:
        return None


async def _insert_signal(
    db: aiosqlite.Connection,
    wallet: str,
    pos: dict,
    action: str,
    now: int,
    market_end_date: str | None = None,
) -> dict:
    signal = {
        "wallet": wallet,
        "market_id": pos.get("conditionId"),
        "outcome": pos.get("outcome"),
        "slug": pos.get("eventSlug"),
        "action": action,
        "price": pos.get("curPrice") or pos.get("currentPrice") or 0,
        "size": pos.get("currentValue") or pos.get("size") or 0,
        "detected_at": now,
        "market_end_date": market_end_date,
    }
    await execute(db,
        "INSERT INTO signals (wallet, market_id, outcome, action, price, size, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (signal["wallet"], signal["market_id"], signal["outcome"], signal["action"],
         signal["price"], signal["size"], signal["detected_at"]),
    )
    logger.info("signal:new", {
        "action": action,
        "wallet": wallet,
        "market": pos.get("conditionId"),
        "price": signal["price"],
    })
    return signal


async def _process_wallet(db: aiosqlite.Connection, wallet: str, now: int) -> list[dict]:
    signals = []
    try:
        positions_raw = await get_wallet_positions(wallet)
        positions = positions_raw if isinstance(positions_raw, list) else []

        current = {f"{p['conditionId']}:{p['outcome']}": p for p in positions}

        known_rows = await fetchall(db,
            "SELECT market_id, outcome, size_usdc FROM positions WHERE wallet = ?",
            (wallet,),
        )
        known = {f"{r['market_id']}:{r['outcome']}": r for r in known_rows}

        for key, pos in current.items():
            if _should_filter(pos):
                continue
            if key not in known:
                end_ts = await _fetch_market_end_date(pos["conditionId"])
                if end_ts is None:
                    logger.warn("signals:skipped-no-end-date", {"market": pos["conditionId"]})
                    continue
                days_to_resolve = (end_ts - now) / 86_400_000
                if days_to_resolve > CONFIG.max_market_days_to_resolve:
                    logger.info("signals:filtered-long-market", {
                        "market": pos["conditionId"],
                        "days_to_resolve": f"{days_to_resolve:.1f}",
                        "max": CONFIG.max_market_days_to_resolve,
                    })
                    continue
                from datetime import datetime, timezone
                end_date_iso = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc).date().isoformat()
                sig = await _insert_signal(db, wallet, pos, "open", now, market_end_date=end_date_iso)
                signals.append(sig)
            else:
                k = known[key]
                current_val = pos.get("currentValue") or pos.get("size") or 0
                if current_val > k["size_usdc"] * 1.1:
                    sig = await _insert_signal(db, wallet, pos, "increase", now)
                    signals.append(sig)

        for key, k in known.items():
            if key not in current:
                market_id, outcome = key.split(":", 1)
                fake_pos = {
                    "conditionId": market_id,
                    "outcome": outcome,
                    "curPrice": 0,
                    "size": k["size_usdc"],
                }
                sig = await _insert_signal(db, wallet, fake_pos, "close", now)
                signals.append(sig)

    except Exception as err:
        logger.error("signals:wallet error", {"wallet": wallet, "error": str(err)})

    return signals


async def detect_signals(db: aiosqlite.Connection) -> list[dict]:
    wallets = await fetchall(db, "SELECT address FROM wallets WHERE active = 1")
    signals = []
    now = int(time.time() * 1000)

    for w in wallets:
        new_signals = await _process_wallet(db, w["address"], now)
        signals.extend(new_signals)

    logger.info("signals:detected", {"count": len(signals)})
    return signals
