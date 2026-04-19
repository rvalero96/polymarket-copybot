"""
Arbitrage executor — paper-tradea oportunidades cualificadas del scanner.
"""

import time
import json
from config import CONFIG
from db.connection import get_db, fetchall, fetchone, execute
from services.polymarket import get_market, get_midpoint_price
from strategies.arbitrage.scanner import scan
from logger import logger


def _load_bankroll_sync(snap) -> float:
    return (snap or {}).get("bankroll") or CONFIG.paper_bankroll


async def _save_bankroll(db, bankroll: float) -> None:
    import datetime
    today = datetime.date.today().isoformat()
    await execute(db, """
        INSERT INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
        VALUES (?, ?, 0, ?, 0, NULL, ?)
        ON CONFLICT(date) DO UPDATE SET
            bankroll   = excluded.bankroll,
            pnl_total  = excluded.pnl_total,
            created_at = excluded.created_at
    """, (today, bankroll, bankroll - CONFIG.paper_bankroll, int(time.time() * 1000)))


async def _settle_open_trades(db) -> int:
    open_trades = await fetchall(db, """
        SELECT at.*, ao.strategy
        FROM arb_trades at
        JOIN arb_opportunities ao ON at.opportunity_id = ao.id
        WHERE at.status = 'open'
    """)

    if not open_trades:
        return 0

    snap     = await fetchone(db, "SELECT bankroll FROM snapshots ORDER BY date DESC LIMIT 1")
    bankroll = _load_bankroll_sync(snap)
    settled  = 0

    for trade in open_trades:
        try:
            market    = await get_market(trade["market_id"])
            resolved  = False
            exit_price = None

            if market and (market.get("closed") or not market.get("active")):
                raw_prices   = market.get("outcomePrices") or "[]"
                raw_outcomes = market.get("outcomes") or '["Yes","No"]'
                prices   = json.loads(raw_prices)   if isinstance(raw_prices, str)   else raw_prices
                outcomes = json.loads(raw_outcomes) if isinstance(raw_outcomes, str) else raw_outcomes
                idx      = outcomes.index(trade["outcome"]) if trade["outcome"] in outcomes else -1
                if idx >= 0 and prices[idx] is not None:
                    exit_price = float(prices[idx])
                    resolved   = True
            else:
                try:
                    mid = await get_midpoint_price(trade["market_id"])
                    if mid >= 0.98:
                        resolved, exit_price = True, 1.0
                    elif mid <= 0.02:
                        resolved, exit_price = True, 0.0
                except Exception:
                    pass

            if not resolved or exit_price is None:
                continue

            fee = trade["size_usdc"] * CONFIG.fee_pct
            pnl = trade["size_usdc"] * (exit_price - trade["price"]) / trade["price"] - fee

            await execute(db,
                "UPDATE arb_trades SET status = 'closed', pnl = ?, closed_at = ? WHERE id = ?",
                (pnl, int(time.time() * 1000), trade["id"]),
            )

            bankroll += trade["size_usdc"] + pnl
            settled  += 1

            logger.info("arb:settle", {
                "trade_id": trade["id"],
                "market": trade["market_id"],
                "outcome": trade["outcome"],
                "pnl": f"{pnl:.4f}",
            })

            remaining = await fetchone(db,
                "SELECT COUNT(*) AS n FROM arb_trades WHERE opportunity_id = ? AND status = 'open'",
                (trade["opportunity_id"],),
            )
            if remaining["n"] == 0:
                await execute(db,
                    "UPDATE arb_opportunities SET status = 'resolved' WHERE id = ?",
                    (trade["opportunity_id"],),
                )

        except Exception as err:
            logger.warn("arb:settle:error", {"trade_id": trade["id"], "error": str(err)})

    if settled > 0:
        await _save_bankroll(db, bankroll)

    return settled


async def _open_opportunity(db, opp: dict, bankroll: float) -> float:
    legs         = json.loads(opp["legs"]) if isinstance(opp["legs"], str) else opp["legs"]
    size_per_leg = bankroll * CONFIG.arb_position_size_pct
    total_cost   = size_per_leg * len(legs)

    if bankroll < total_cost:
        logger.warn("arb:open:insufficient_bankroll", {"need": total_cost, "have": bankroll})
        return bankroll

    now = int(time.time() * 1000)

    for i, leg in enumerate(legs):
        eff_price = leg["price"] * (1 + CONFIG.slippage_pct)
        fee       = size_per_leg * CONFIG.fee_pct
        slippage  = size_per_leg * CONFIG.slippage_pct

        await execute(db, """
            INSERT INTO arb_trades
                (opportunity_id, leg_index, market_id, outcome, side, price, size_usdc, fee, slippage, opened_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (opp["id"], i, leg["market_id"], leg["outcome"], leg["side"], eff_price, size_per_leg, fee, slippage, now))

        bankroll -= size_per_leg + fee

    await execute(db, "UPDATE arb_opportunities SET status = 'traded' WHERE id = ?", (opp["id"],))
    logger.info("arb:open", {
        "opportunity_id": opp["id"],
        "strategy": opp["strategy"],
        "legs": len(legs),
        "size_per_leg": f"{size_per_leg:.2f}",
    })

    return bankroll


async def run_arbitrage() -> None:
    logger.info("arb:executor:start")
    db = await get_db()

    settled = await _settle_open_trades(db)
    logger.info("arb:executor:settled", {"count": settled})

    await scan(db)

    candidates = await fetchall(db, """
        SELECT * FROM arb_opportunities
        WHERE status = 'open'
          AND expected_profit >= ?
          AND confidence >= ?
        ORDER BY expected_profit DESC
    """, (CONFIG.arb_min_profit_pct, CONFIG.arb_min_confidence))

    if not candidates:
        logger.info("arb:executor:no_candidates")
        return

    open_count = (await fetchone(db,
        "SELECT COUNT(DISTINCT opportunity_id) AS n FROM arb_trades WHERE status = 'open'"
    ))["n"]

    if open_count >= CONFIG.arb_max_open_positions:
        logger.info("arb:executor:max_positions", {"open": open_count, "max": CONFIG.arb_max_open_positions})
        return

    snap     = await fetchone(db, "SELECT bankroll FROM snapshots ORDER BY date DESC LIMIT 1")
    bankroll = _load_bankroll_sync(snap)
    opened   = 0

    for opp in candidates:
        if open_count + opened >= CONFIG.arb_max_open_positions:
            break
        try:
            bankroll = await _open_opportunity(db, opp, bankroll)
            opened  += 1
        except Exception as err:
            logger.error("arb:executor:open_error", {"opportunity_id": opp["id"], "error": str(err)})

    await _save_bankroll(db, bankroll)
    logger.info("arb:executor:done", {"opened": opened, "bankroll": f"{bankroll:.2f}"})
