import asyncio
import datetime
import time

from fastapi import APIRouter, Depends, Query
from api.auth import require_token
from db.connection import get_db, fetchone, fetchall
from defi.aave import get_aave_stats
from config import CONFIG

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


async def _get_live_balances() -> dict:
    """Fetches real balances from Binance."""
    from services.binance import get_account_balances

    try:
        binance_bal = await get_account_balances()
    except Exception:
        binance_bal = {}

    return {"binance": binance_bal}


async def _get_live_initial_bankroll(db, current_bankroll: float) -> float:
    """
    Returns the initial bankroll reference for P&L calculation.
    Uses the oldest snapshot in live.db. If none exists yet (first ever load),
    seeds it with the current balance so P&L starts at 0.
    """
    first = await fetchone(db, "SELECT bankroll FROM snapshots ORDER BY date ASC LIMIT 1")
    if first and first.get("bankroll"):
        return float(first["bankroll"])
    return current_bankroll


async def _save_live_snapshot(db, bankroll: float, portfolio_total: float, open_positions: int, initial_bankroll: float):
    """Saves a daily snapshot to live.db with the real balance."""
    today = datetime.date.today().isoformat()
    existing = await fetchone(db, "SELECT bankroll FROM snapshots WHERE date = ?", (today,))
    prev = await fetchone(db, "SELECT bankroll FROM snapshots ORDER BY date DESC LIMIT 1")
    prev_bankroll = (prev or {}).get("bankroll") or bankroll
    pnl_day   = round(bankroll - prev_bankroll, 4) if existing is None else (existing.get("pnl_day") or 0)
    pnl_total = round(portfolio_total - initial_bankroll, 4)
    now_ms    = int(time.time() * 1000)

    await db.execute(
        """INSERT INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(date) DO UPDATE SET
               bankroll=excluded.bankroll,
               pnl_total=excluded.pnl_total,
               open_positions=excluded.open_positions,
               created_at=excluded.created_at""",
        (today, round(bankroll, 4), pnl_day, pnl_total, open_positions, now_ms),
    )
    await db.commit()


@router.get("")
async def get_dashboard(
    mode: str = Query(default="paper"),
    _: str = Depends(require_token),
):
    db = await get_db(mode)
    initial_bankroll = CONFIG.paper_bankroll

    # ── Live mode: real balances from external sources ─────────────────────
    sources = {}
    btc_price = 0.0
    if mode == "live":
        from services.binance import fetch_spot_price
        raw = await _get_live_balances()
        sources = raw

        # BTC price for valuation
        try:
            btc_price = await fetch_spot_price("BTCUSDT")
        except Exception:
            btc_price = 0.0

        binance = raw.get("binance", {})

        binance_usdt       = (binance.get("USDT") or {}).get("free", 0.0)
        binance_usdc       = (binance.get("USDC") or {}).get("free", 0.0)
        binance_btc        = (binance.get("BTC")  or {}).get("free", 0.0)
        binance_btc_locked = (binance.get("BTC")  or {}).get("locked", 0.0)

        bankroll        = binance_usdt + binance_usdc
        btc_value       = (binance_btc + binance_btc_locked) * btc_price
        portfolio_total = bankroll + btc_value
        capital_active  = btc_value

        initial_bankroll = await _get_live_initial_bankroll(db, portfolio_total)
        await _save_live_snapshot(db, bankroll, portfolio_total, 0, initial_bankroll)

        snaps_history = await fetchall(db, "SELECT date, bankroll, pnl_day FROM snapshots ORDER BY date ASC")

        return {
            "bankroll":         round(bankroll, 2),
            "portfolio_total":  round(portfolio_total, 2),
            "initial_bankroll": initial_bankroll,
            "pnl_total":        round(portfolio_total - initial_bankroll, 2) if initial_bankroll else 0,
            "pnl_total_pct":    round((portfolio_total - initial_bankroll) / initial_bankroll * 100, 2) if initial_bankroll else 0,
            "pnl_day":          0.0,
            "win_rate":         0.0,
            "open_positions":   0,
            "capital_active":   round(capital_active, 2),
            "snapshots":        snaps_history,
            "trade_counts":     {},
            "last_updated":     int(time.time() * 1000),
            "sources": {
                "binance": {
                    "usdt":      round(binance_usdt, 2),
                    "usdc":      round(binance_usdc, 2),
                    "btc":       round(binance_btc + binance_btc_locked, 8),
                    "btc_usd":   round(btc_value, 2),
                    "btc_price": round(btc_price, 2),
                },
            },
        }

    # ── Paper mode: existing logic ─────────────────────────────────────────
    snap = await fetchone(db, "SELECT * FROM snapshots ORDER BY date DESC LIMIT 1")

    bankroll      = (snap or {}).get("bankroll") or initial_bankroll
    pnl_day       = (snap or {}).get("pnl_day") or 0
    win_rate      = (snap or {}).get("win_rate") or 0

    copy_active   = (await fetchone(db, "SELECT COALESCE(SUM(size_usdc), 0) AS s FROM positions"))["s"] or 0
    btc5m_active  = (await fetchone(db, "SELECT COALESCE(SUM(size_usdc), 0) AS s FROM btc5m_positions"))["s"] or 0
    grid_capital  = (await fetchone(db, "SELECT COALESCE(SUM(order_size), 0) AS s FROM grid_orders WHERE status='bought'"))["s"] or 0
    pepe_capital  = (await fetchone(db, "SELECT COALESCE(SUM(order_size), 0) AS s FROM pepe_grid_orders WHERE status='bought'"))["s"] or 0
    stoch_capital = (await fetchone(db, "SELECT COALESCE(SUM(order_size), 0) AS s FROM stoch_btc_trades WHERE status='open'"))["s"] or 0
    capital_active = copy_active + btc5m_active + grid_capital + pepe_capital + stoch_capital
    portfolio_total = bankroll + capital_active

    snaps_history = await fetchall(db, "SELECT date, bankroll, pnl_day FROM snapshots ORDER BY date ASC")

    aave = await get_aave_stats(db)
    aave_history = await fetchall(db, "SELECT * FROM aave_yields ORDER BY created_at DESC LIMIT 100")

    kelly = await fetchone(db, "SELECT * FROM kelly_snapshots ORDER BY created_at DESC LIMIT 1")
    kelly_history = await fetchall(db, "SELECT * FROM kelly_snapshots ORDER BY created_at DESC LIMIT 100")

    copy_trades  = (await fetchone(db, "SELECT COUNT(*) AS n FROM trades WHERE status = 'closed'"))["n"]
    btc5m_trades = (await fetchone(db, "SELECT COUNT(*) AS n FROM btc5m_trades WHERE status != 'open'"))["n"]
    arb_trades   = (await fetchone(db, "SELECT COUNT(*) AS n FROM arb_trades WHERE status = 'closed'"))["n"]
    grid_trades  = (await fetchone(db, "SELECT COUNT(*) AS n FROM grid_trades"))["n"]
    pepe_trades  = (await fetchone(db, "SELECT COUNT(*) AS n FROM pepe_grid_trades"))["n"]

    copy_open  = (await fetchone(db, "SELECT COUNT(*) AS n FROM positions"))["n"]
    copy_wins  = (await fetchone(db, "SELECT COUNT(*) AS n FROM trades WHERE status = 'closed' AND pnl > 0"))["n"]
    copy_pnl   = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM trades WHERE status = 'closed'"))["s"] or 0

    btc5m_open = (await fetchone(db, "SELECT COUNT(*) AS n FROM btc5m_positions"))["n"]
    btc5m_wins = (await fetchone(db, "SELECT COUNT(*) AS n FROM btc5m_trades WHERE status != 'open' AND pnl > 0"))["n"]
    btc5m_pnl  = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM btc5m_trades WHERE status != 'open'"))["s"] or 0

    arb_open       = (await fetchone(db, "SELECT COUNT(*) AS n FROM arb_trades WHERE status = 'open'"))["n"]
    arb_wins       = (await fetchone(db, "SELECT COUNT(*) AS n FROM arb_trades WHERE status = 'closed' AND pnl > 0"))["n"]
    arb_pnl        = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM arb_trades WHERE status = 'closed'"))["s"] or 0
    arb_active_opps = (await fetchone(db, "SELECT COUNT(*) AS n FROM arb_opportunities WHERE status = 'open'"))["n"]
    arb_avg_profit = (await fetchone(db, "SELECT AVG(expected_profit) AS v FROM arb_opportunities WHERE status = 'open'"))["v"]

    grid_pnl      = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM grid_trades"))["s"] or 0
    grid_wins     = (await fetchone(db, "SELECT COUNT(*) AS n FROM grid_trades WHERE pnl > 0"))["n"]
    grid_win_rate = round(grid_wins / grid_trades * 100, 1) if grid_trades > 0 else 0
    grid_active   = (await fetchone(db, "SELECT COUNT(*) AS n FROM grid_orders WHERE status IN ('pending','bought')"))["n"]
    grid_bought   = (await fetchone(db, "SELECT COUNT(*) AS n FROM grid_orders WHERE status='bought'"))["n"]

    pepe_pnl      = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM pepe_grid_trades"))["s"] or 0
    pepe_wins     = (await fetchone(db, "SELECT COUNT(*) AS n FROM pepe_grid_trades WHERE pnl > 0"))["n"]
    pepe_win_rate = round(pepe_wins / pepe_trades * 100, 1) if pepe_trades > 0 else 0
    pepe_active   = (await fetchone(db, "SELECT COUNT(*) AS n FROM pepe_grid_orders WHERE status IN ('pending','bought')"))["n"]
    pepe_bought   = (await fetchone(db, "SELECT COUNT(*) AS n FROM pepe_grid_orders WHERE status='bought'"))["n"]

    stoch_trades   = (await fetchone(db, "SELECT COUNT(*) AS n FROM stoch_btc_trades WHERE status='closed'"))["n"]
    stoch_pnl      = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM stoch_btc_trades WHERE status='closed'"))["s"] or 0
    stoch_wins     = (await fetchone(db, "SELECT COUNT(*) AS n FROM stoch_btc_trades WHERE status='closed' AND pnl > 0"))["n"]
    stoch_win_rate = round(stoch_wins / stoch_trades * 100, 1) if stoch_trades > 0 else 0
    stoch_signals  = (await fetchone(db, "SELECT COUNT(*) AS n FROM stoch_btc_signals"))["n"]
    stoch_open     = (await fetchone(db, "SELECT COUNT(*) AS n FROM stoch_btc_trades WHERE status='open'"))["n"]

    active_wallets = await fetchall(
        db, "SELECT address, win_rate, roi, score, name FROM wallets WHERE active = 1 ORDER BY score DESC"
    )

    return {
        "bankroll":         bankroll,
        "portfolio_total":  portfolio_total,
        "initial_bankroll": initial_bankroll,
        "pnl_total":        portfolio_total - initial_bankroll,
        "pnl_total_pct":    ((portfolio_total - initial_bankroll) / initial_bankroll * 100) if initial_bankroll else 0,
        "pnl_day":          pnl_day,
        "win_rate":         win_rate,
        "open_positions":   copy_open + btc5m_open + arb_open + grid_active + stoch_open,
        "capital_active":   capital_active,
        "capital_copy":     copy_active,
        "capital_btc5m":    btc5m_active,
        "capital_grid":     grid_capital,
        "capital_pepe":     pepe_capital,
        "capital_stoch":    stoch_capital,
        "snapshots":        snaps_history,
        "aave": {
            **aave,
            "cash_idle": bankroll,
            "yield_day_est":  bankroll * aave["avg_apy"] / 365 if aave["avg_apy"] else 0,
            "yield_year_est": bankroll * aave["avg_apy"] if aave["avg_apy"] else 0,
        },
        "aave_history": aave_history,
        "kelly": {
            "phase":          (kelly or {}).get("phase"),
            "win_rate":       (kelly or {}).get("win_rate"),
            "odds_b":         (kelly or {}).get("odds_b"),
            "raw_kelly":      (kelly or {}).get("raw_kelly"),
            "multiplier":     (kelly or {}).get("multiplier"),
            "fraction":       (kelly or {}).get("fraction"),
            "trading_budget": (kelly or {}).get("trading_budget"),
            "aave_budget":    (kelly or {}).get("aave_budget"),
            "position_size":  (kelly or {}).get("position_size"),
            "portfolio":      (kelly or {}).get("portfolio"),
            "total_trades":   (kelly or {}).get("total_trades"),
        } if kelly else None,
        "kelly_history": kelly_history,
        "trade_counts": {
            "copy_trading": copy_trades,
            "btc5m":        btc5m_trades,
            "arbitrage":    arb_trades,
            "grid":         grid_trades,
            "grid_pepe":    pepe_trades,
            "stoch_btc":    stoch_trades,
        },
        "copy_stats": {
            "win_rate":   (copy_wins / copy_trades * 100) if copy_trades > 0 else 0,
            "pnl":        copy_pnl,
            "open_count": copy_open,
            "closed":     copy_trades,
        },
        "btc5m_stats": {
            "win_rate":   (btc5m_wins / btc5m_trades * 100) if btc5m_trades > 0 else 0,
            "pnl":        btc5m_pnl,
            "open_count": btc5m_open,
            "closed":     btc5m_trades,
        },
        "arb_stats": {
            "win_rate":       (arb_wins / arb_trades * 100) if arb_trades > 0 else 0,
            "pnl":            arb_pnl,
            "open_trades":    arb_open,
            "closed":         arb_trades,
            "active_opps":    arb_active_opps,
            "avg_profit":     arb_avg_profit,
        },
        "grid_stats": {
            "win_rate":      grid_win_rate,
            "pnl":           round(grid_pnl, 4),
            "trade_count":   grid_trades,
            "active_orders": grid_active,
            "bought_orders": grid_bought,
            "capital":       round(grid_capital, 2),
        },
        "pepe_grid_stats": {
            "win_rate":      pepe_win_rate,
            "pnl":           round(pepe_pnl, 10),
            "trade_count":   pepe_trades,
            "active_orders": pepe_active,
            "bought_orders": pepe_bought,
            "capital":       round(pepe_capital, 6),
        },
        "stoch_btc_stats": {
            "win_rate":      stoch_win_rate,
            "pnl":           round(stoch_pnl, 4),
            "trade_count":   stoch_trades,
            "signal_count":  stoch_signals,
            "open_trades":   stoch_open,
        },
        "active_wallets": active_wallets,
        "last_updated":   (snap or {}).get("created_at"),
    }
