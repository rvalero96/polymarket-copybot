"""
Simulator — motor principal de copy trading.
"""

import time
from config import CONFIG
from db.connection import get_db, fetchone, fetchall, execute
from strategies.copy_trading.signals import detect_signals
from strategies.copy_trading.risk_manager import check_position_risks
from defi.aave import apply_aave_yield
from defi.kelly import get_kelly_allocation, save_kelly_snapshot
from logger import logger


async def _compute_win_rate(db) -> float:
    copy  = await fetchone(db, "SELECT COUNT(*) AS total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins FROM trades WHERE status = 'closed' AND pnl IS NOT NULL")
    btc5m = await fetchone(db, "SELECT COUNT(*) AS total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins FROM btc5m_trades WHERE status != 'open' AND pnl IS NOT NULL")
    total = (copy["total"] or 0) + (btc5m["total"] or 0)
    wins  = (copy["wins"]  or 0) + (btc5m["wins"]  or 0)
    return wins / total if total > 0 else 0.0


async def _execute_signal(db, signal: dict, bankroll: float, position_size: float) -> float:
    now = int(time.time() * 1000)

    if signal["action"] in ("open", "increase"):
        size_usdc      = min(position_size, bankroll)
        slippage       = size_usdc * CONFIG.slippage_pct
        fee            = size_usdc * CONFIG.fee_pct
        effective_price = signal["price"] * (1 + CONFIG.slippage_pct)
        slug           = signal.get("slug")
        market_end_date = signal.get("market_end_date")

        await execute(db,
            "INSERT INTO trades (market_id, outcome, side, size_usdc, price, fee, slippage, executed_at) VALUES (?, ?, 'buy', ?, ?, ?, ?, ?)",
            (signal["market_id"], signal["outcome"], size_usdc, effective_price, fee, slippage, now),
        )
        await execute(db, """
            INSERT INTO positions
                (market_id, outcome, wallet, avg_price, size_usdc, slug, opened_at,
                 market_end_date, last_price, price_tracked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(market_id, outcome, wallet) DO UPDATE SET
                avg_price       = (avg_price * size_usdc + excluded.avg_price * excluded.size_usdc)
                                  / (size_usdc + excluded.size_usdc),
                size_usdc       = size_usdc + excluded.size_usdc,
                slug            = COALESCE(excluded.slug, positions.slug),
                market_end_date = COALESCE(excluded.market_end_date, positions.market_end_date)
        """, (
            signal["market_id"], signal["outcome"], signal["wallet"],
            effective_price, size_usdc, slug, now,
            market_end_date, effective_price, now,
        ))

        logger.info("trade:open", {
            "market": signal["market_id"],
            "size": f"{size_usdc:.2f}",
            "price": f"{effective_price:.4f}",
        })
        return bankroll - size_usdc - fee

    if signal["action"] == "close":
        pos = await fetchone(db,
            "SELECT * FROM positions WHERE market_id = ? AND outcome = ? AND wallet = ?",
            (signal["market_id"], signal["outcome"], signal["wallet"]),
        )
        if not pos:
            return bankroll

        close_price = signal["price"] or pos["avg_price"]
        pnl         = pos["size_usdc"] * (close_price - pos["avg_price"]) / pos["avg_price"]
        fee         = pos["size_usdc"] * CONFIG.fee_pct

        await execute(db,
            "UPDATE trades SET status = 'closed', pnl = ? WHERE market_id = ? AND outcome = ?",
            (pnl - fee, signal["market_id"], signal["outcome"]),
        )
        await execute(db,
            "DELETE FROM positions WHERE market_id = ? AND outcome = ? AND wallet = ?",
            (signal["market_id"], signal["outcome"], signal["wallet"]),
        )

        logger.info("trade:close", {"market": signal["market_id"], "pnl": f"{pnl:.4f}", "fee": f"{fee:.4f}"})
        return bankroll + pos["size_usdc"] + pnl - fee

    return bankroll


async def run_simulator() -> None:
    logger.info("simulator:start", {"mode": CONFIG.trading_mode})
    db = await get_db()

    if CONFIG.trading_mode == "live":
        logger.error("simulator:live mode not wired yet — set TRADING_MODE=paper")
        return

    today    = __import__("datetime").date.today().isoformat()
    snapshots = await fetchall(db, "SELECT * FROM snapshots ORDER BY date DESC LIMIT 2")
    today_snap = next((s for s in snapshots if s["date"] == today), None)
    prev_snap  = next((s for s in snapshots if s["date"] != today), None)
    bankroll   = (today_snap or prev_snap or {}).get("bankroll") or CONFIG.paper_bankroll

    # AAVE yield
    bankroll = await apply_aave_yield(db, bankroll)

    # Risk manager
    bankroll = await check_position_risks(db, bankroll)

    # Kelly allocation
    copy_total  = (await fetchone(db, "SELECT COALESCE(SUM(size_usdc), 0) AS t FROM positions"))["t"]
    btc5m_total = (await fetchone(db, "SELECT COALESCE(SUM(size_usdc), 0) AS t FROM btc5m_positions"))["t"]
    portfolio   = bankroll + copy_total + btc5m_total
    kelly       = await get_kelly_allocation(db, portfolio)
    await save_kelly_snapshot(db, portfolio, kelly)

    kelly_budget   = kelly["trading_budget"] if kelly["trading_budget"] > 0 else portfolio * CONFIG.position_size_pct * CONFIG.max_open_positions
    kelly_pos_size = kelly["position_size"]  if kelly["position_size"]  > 0 else portfolio * CONFIG.position_size_pct

    signals = await detect_signals(db)
    if not signals:
        logger.info("simulator:no signals, done")

    day_start_bankroll = (prev_snap or {}).get("bankroll") or CONFIG.paper_bankroll

    for signal in signals:
        if signal["action"] in ("open", "increase"):
            open_count = (await fetchone(db, "SELECT COUNT(*) AS n FROM positions"))["n"]
            if open_count >= CONFIG.max_open_positions:
                logger.warn("simulator:max positions reached, skipping open", {"open_count": open_count})
                continue

            total_open = (await fetchone(db, "SELECT COALESCE(SUM(size_usdc), 0) AS total FROM positions"))["total"]
            if total_open + kelly_pos_size > kelly_budget:
                logger.warn("simulator:kelly budget reached, skipping open", {
                    "total_open": f"{total_open:.2f}",
                    "kelly_budget": f"{kelly_budget:.2f}",
                    "phase": kelly["phase"],
                })
                continue

        try:
            bankroll = await _execute_signal(db, signal, bankroll, kelly_pos_size)
        except Exception as err:
            logger.error("simulator:signal error", {"signal": signal, "error": str(err)})

    # Guardar snapshot
    open_count = (await fetchone(db, "SELECT COUNT(*) AS n FROM positions"))["n"]
    win_rate   = await _compute_win_rate(db)

    await execute(db, """
        INSERT INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
            bankroll       = excluded.bankroll,
            pnl_day        = excluded.pnl_day,
            pnl_total      = excluded.pnl_total,
            open_positions = excluded.open_positions,
            win_rate       = excluded.win_rate,
            created_at     = excluded.created_at
    """, (
        today, bankroll,
        bankroll - day_start_bankroll,
        bankroll - CONFIG.paper_bankroll,
        open_count, win_rate,
        int(time.time() * 1000),
    ))

    logger.info("simulator:done", {"bankroll": f"{bankroll:.2f}"})
