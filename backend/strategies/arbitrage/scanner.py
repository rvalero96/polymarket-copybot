"""
Arbitrage scanner — detecta inconsistencias de precio entre mercados relacionados.

Estrategias:
  monotonicity — umbral mayor debe tener ≤ probabilidad que umbral menor
  basket       — suma de outcomes en mercado categórico debe ≈ 1.0
  spread       — YES + NO en binario no debe comprimirse bajo threshold
"""

import re
import json
import asyncio
import aiosqlite
from config import CONFIG
from db.connection import fetchall, fetchone, execute
from services.polymarket import get_active_markets, get_midpoint_price
from logger import logger

ROUND_TRIP_COST = (CONFIG.fee_pct + CONFIG.slippage_pct) * 2


async def _fetch_markets() -> list[dict]:
    markets  = []
    page_size = 100
    offset   = 0

    while len(markets) < CONFIG.arb_scan_limit:
        batch = await get_active_markets(limit=page_size, offset=offset)
        if not batch:
            break
        markets.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size

    return [
        m for m in markets
        if m.get("active")
        and not m.get("closed")
        and (m.get("outcomePrices") or m.get("clobTokenIds"))
        and float(m.get("liquidity") or 0) >= CONFIG.arb_min_leg_liquidity
    ]


def _extract_prices(market: dict) -> dict:
    raw_outcomes = market.get("outcomes") or '["Yes","No"]'
    raw_prices   = market.get("outcomePrices") or "[]"

    outcomes = json.loads(raw_outcomes) if isinstance(raw_outcomes, str) else raw_outcomes
    prices   = json.loads(raw_prices)   if isinstance(raw_prices, str)   else raw_prices

    result = {}
    for i, outcome in enumerate(outcomes):
        p = float(prices[i]) if i < len(prices) and prices[i] is not None else None
        result[outcome] = p if (p is not None and p > 0) else None
    return result


def _extract_threshold(question: str | None) -> float | None:
    if not question:
        return None
    matches = re.findall(r'\$?([\d,]+(?:\.\d+)?)\s*[kKmMbB]?\b', question)
    for raw in matches:
        clean = raw.replace("$", "").replace(",", "").strip().lower()
        mult  = 1e3 if clean.endswith("k") else 1e6 if clean.endswith("m") else 1e9 if clean.endswith("b") else 1
        val   = float(clean.rstrip("kmb")) * mult
        if val >= 100:
            return val
    return None


def _question_template(question: str | None) -> str:
    if not question:
        return ""
    q = re.sub(r'\$[\d,]+(?:\.\d+)?(?:\s*[kKmMbB])?', '?', question)
    q = re.sub(r'\b[\d,]+(?:\.\d+)?\s*[kKmMbB]?\b', '?', q)
    q = q.lower()
    q = re.sub(r'[^a-z?]+', ' ', q)
    return re.sub(r'\s+', ' ', q).strip()


def _slug_base(slug: str | None) -> str | None:
    if not slug:
        return None
    s = re.sub(r'-\d{10,}$', '', slug)
    s = re.sub(r'(-\d+)+$', '', s)
    return s.lower()


def _detect_monotonicity(group: list[dict]) -> list[dict]:
    if len(group) < 2:
        return []

    sorted_group  = sorted(group, key=lambda m: m["threshold"])
    opportunities = []

    for i in range(len(sorted_group) - 1):
        for j in range(i + 1, len(sorted_group)):
            low  = sorted_group[i]
            high = sorted_group[j]

            yes_low  = low["prices"].get("Yes")  or low["prices"].get("YES")
            yes_high = high["prices"].get("Yes") or high["prices"].get("YES")
            if yes_low is None or yes_high is None or yes_low <= 0 or yes_high <= 0:
                continue

            violation = yes_high - yes_low
            if violation <= 0:
                continue

            cost            = yes_low + (1 - yes_high)
            gross_profit    = 1 - cost
            expected_profit = gross_profit - ROUND_TRIP_COST
            if expected_profit <= 0:
                continue

            confidence = min(1.0,
                (violation / 0.15) * 0.5 +
                (min(low["liquidity"], high["liquidity"]) / 5000) * 0.3 +
                (0.2 if violation > 0.05 else 0)
            )

            opportunities.append({
                "strategy": "monotonicity",
                "description": f"YES@{low['threshold']} ({yes_low*100:.1f}%) + NO@{high['threshold']} ({(1-yes_high)*100:.1f}%) — violation +{violation*100:.1f}%",
                "expected_profit": expected_profit,
                "confidence": confidence,
                "legs": [
                    {"market_id": low["conditionId"],  "outcome": "Yes", "side": "buy", "price": yes_low,       "threshold": low["threshold"]},
                    {"market_id": high["conditionId"], "outcome": "No",  "side": "buy", "price": 1 - yes_high, "threshold": high["threshold"]},
                ],
                "market_ids": [low["conditionId"], high["conditionId"]],
            })

    return opportunities


def _detect_basket(market: dict) -> dict | None:
    outcomes = list(market["prices"].keys())
    if len(outcomes) < 3:
        return None

    valid_prices = [market["prices"][o] for o in outcomes if market["prices"].get(o)]
    if len(valid_prices) != len(outcomes):
        return None

    total = sum(valid_prices)
    if total >= CONFIG.arb_basket_underpriced_threshold:
        return None

    legs         = [{"market_id": market["conditionId"], "outcome": o, "side": "buy", "price": market["prices"][o]} for o in outcomes]
    gross_profit = 1 - total
    expected     = gross_profit - ROUND_TRIP_COST * len(legs)
    if expected <= 0:
        return None

    confidence = min(1.0, (gross_profit / 0.10) * 0.6 + (market["liquidity"] / 10000) * 0.4)

    return {
        "strategy": "basket",
        "description": f"Multi-outcome sum={total:.3f} — {(market.get('question') or '')[:60]}",
        "expected_profit": expected,
        "confidence": confidence,
        "legs": legs,
        "market_ids": [market["conditionId"]],
    }


def _detect_spread(market: dict) -> dict | None:
    outcomes = list(market["prices"].keys())
    if len(outcomes) != 2:
        return None

    oa, ob = outcomes
    pa, pb = market["prices"].get(oa), market["prices"].get(ob)
    if pa is None or pb is None or pa <= 0 or pb <= 0:
        return None

    total = pa + pb
    if total >= CONFIG.arb_spread_anomaly_threshold:
        return None

    gross    = 1 - total
    expected = gross - ROUND_TRIP_COST * 2
    if expected <= 0:
        return None

    confidence = min(1.0, (gross / 0.05) * 0.7 + (market["liquidity"] / 5000) * 0.3)

    return {
        "strategy": "spread",
        "description": f"{oa}({pa*100:.1f}%) + {ob}({pb*100:.1f}%) = {total*100:.1f}% — anomalous sum",
        "expected_profit": expected,
        "confidence": confidence,
        "legs": [
            {"market_id": market["conditionId"], "outcome": oa, "side": "buy", "price": pa},
            {"market_id": market["conditionId"], "outcome": ob, "side": "buy", "price": pb},
        ],
        "market_ids": [market["conditionId"]],
    }


async def _save_opportunity(db: aiosqlite.Connection, opp: dict) -> None:
    import time
    now       = int(time.time() * 1000)
    group_key = "|".join(sorted(opp["market_ids"]))

    await execute(db, """
        INSERT INTO arb_groups (group_key, strategy, market_ids, detected_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_key, strategy) DO UPDATE SET
            market_ids  = excluded.market_ids,
            detected_at = excluded.detected_at,
            resolved_at = NULL
    """, (group_key, opp["strategy"], json.dumps(opp["market_ids"]), now))

    group = await fetchone(db,
        "SELECT id FROM arb_groups WHERE group_key = ? AND strategy = ?",
        (group_key, opp["strategy"]),
    )

    await execute(db, """
        INSERT INTO arb_opportunities
            (group_id, strategy, description, expected_profit, confidence, legs, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (
        group["id"], opp["strategy"], opp["description"],
        opp["expected_profit"], opp["confidence"],
        json.dumps(opp["legs"]), now,
    ))


async def scan(db: aiosqlite.Connection) -> list[dict]:
    import time
    logger.info("arb:scan:start")

    await execute(db,
        "UPDATE arb_opportunities SET status = 'expired' WHERE status = 'open' AND detected_at < ?",
        (int(time.time() * 1000) - 2 * 3_600_000,),
    )

    markets = await _fetch_markets()
    logger.info("arb:scan:markets", {"count": len(markets)})
    if not markets:
        logger.info("arb:scan:done", {"opportunities": 0})
        return []

    enriched = [
        {
            **m,
            "prices": _extract_prices(m),
            "liquidity": float(m.get("liquidity") or 0),
            "threshold": _extract_threshold(m.get("question")),
        }
        for m in markets
    ]

    # Agrupar para monotonicity
    mono_groups: dict[str, list] = {}

    def add_to_group(key, market):
        if not key:
            return
        mono_groups.setdefault(key, []).append(market)

    for m in enriched:
        if m["threshold"] is None:
            continue
        tmpl = _question_template(m.get("question"))
        if tmpl:
            add_to_group(f"tmpl:{tmpl}", m)
        sb = _slug_base(m.get("slug"))
        if sb:
            add_to_group(f"slug:{sb}", m)

    # Deduplicar dentro de cada grupo
    for key, group in mono_groups.items():
        seen = set()
        mono_groups[key] = [m for m in group if not (m["conditionId"] in seen or seen.add(m["conditionId"]))]

    opportunities = []

    for group in mono_groups.values():
        if len(group) < 2:
            continue
        for opp in _detect_monotonicity(group):
            logger.info("arb:opportunity", {"strategy": opp["strategy"], "profit": f"{opp['expected_profit']:.4f}"})
            await _save_opportunity(db, opp)
            opportunities.append(opp)

    for m in enriched:
        basket = _detect_basket(m)
        if basket:
            logger.info("arb:opportunity", {"strategy": basket["strategy"], "profit": f"{basket['expected_profit']:.4f}"})
            await _save_opportunity(db, basket)
            opportunities.append(basket)

    # Spread: top 50 por liquidez con precios reales de CLOB
    spread_candidates = sorted(
        [m for m in enriched if len(m["prices"]) == 2],
        key=lambda m: m["liquidity"],
        reverse=True,
    )[:50]

    logger.info("arb:scan:spread_check", {"checking": len(spread_candidates)})

    for m in spread_candidates:
        try:
            raw_token_ids = m.get("clobTokenIds") or "[]"
            token_ids     = json.loads(raw_token_ids) if isinstance(raw_token_ids, str) else raw_token_ids
            outcomes      = list(m["prices"].keys())
            if len(token_ids) < 2:
                continue

            p0, p1 = await asyncio.gather(
                get_midpoint_price(token_ids[0]),
                get_midpoint_price(token_ids[1]),
            )

            clob_prices = {outcomes[0]: p0, outcomes[1]: p1}
            m_clob      = {**m, "prices": clob_prices}
            spread      = _detect_spread(m_clob)
            if spread:
                logger.info("arb:opportunity", {"strategy": spread["strategy"], "profit": f"{spread['expected_profit']:.4f}", "sum": f"{p0+p1:.4f}"})
                await _save_opportunity(db, spread)
                opportunities.append(spread)
        except Exception as err:
            logger.warn("arb:spread_clob_error", {"market": m["conditionId"], "error": str(err)})

    logger.info("arb:scan:done", {"opportunities": len(opportunities)})
    return opportunities
