from fastapi import APIRouter, Depends
from api.auth import require_token
from db.connection import get_db, fetchone, fetchall
from defi.aave import get_aave_stats
from config import CONFIG

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("")
async def get_dashboard(_: str = Depends(require_token)):
    db = await get_db()

    snap = await fetchone(db, "SELECT * FROM snapshots ORDER BY date DESC LIMIT 1")

    bankroll     = (snap or {}).get("bankroll") or CONFIG.paper_bankroll
    pnl_day      = (snap or {}).get("pnl_day") or 0
    win_rate     = (snap or {}).get("win_rate") or 0
    open_pos_snap = (snap or {}).get("open_positions") or 0

    # Capital activo (live)
    copy_active   = (await fetchone(db, "SELECT COALESCE(SUM(size_usdc), 0) AS s FROM positions"))["s"] or 0
    btc5m_active  = (await fetchone(db, "SELECT COALESCE(SUM(size_usdc), 0) AS s FROM btc5m_positions"))["s"] or 0
    grid_capital  = (await fetchone(db, "SELECT COALESCE(SUM(order_size), 0) AS s FROM grid_orders WHERE status='bought'"))["s"] or 0
    pepe_capital  = (await fetchone(db, "SELECT COALESCE(SUM(order_size), 0) AS s FROM pepe_grid_orders WHERE status='bought'"))["s"] or 0
    capital_active = copy_active + btc5m_active + grid_capital + pepe_capital
    portfolio_total = bankroll + capital_active

    # Snapshot history for charts
    snaps_history = await fetchall(db, "SELECT date, bankroll, pnl_day FROM snapshots ORDER BY date ASC")

    # AAVE
    aave = await get_aave_stats(db)
    aave_history = await fetchall(db, "SELECT * FROM aave_yields ORDER BY created_at DESC LIMIT 100")

    # Kelly
    kelly = await fetchone(db, "SELECT * FROM kelly_snapshots ORDER BY created_at DESC LIMIT 1")
    kelly_history = await fetchall(db, "SELECT * FROM kelly_snapshots ORDER BY created_at DESC LIMIT 100")

    # Trade counts
    copy_trades  = (await fetchone(db, "SELECT COUNT(*) AS n FROM trades WHERE status = 'closed'"))["n"]
    btc5m_trades = (await fetchone(db, "SELECT COUNT(*) AS n FROM btc5m_trades WHERE status != 'open'"))["n"]
    arb_trades   = (await fetchone(db, "SELECT COUNT(*) AS n FROM arb_trades WHERE status = 'closed'"))["n"]
    grid_trades  = (await fetchone(db, "SELECT COUNT(*) AS n FROM grid_trades"))["n"]
    pepe_trades  = (await fetchone(db, "SELECT COUNT(*) AS n FROM pepe_grid_trades"))["n"]

    # Copy stats
    copy_open   = (await fetchone(db, "SELECT COUNT(*) AS n FROM positions"))["n"]
    copy_wins   = (await fetchone(db, "SELECT COUNT(*) AS n FROM trades WHERE status = 'closed' AND pnl > 0"))["n"]
    copy_pnl    = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM trades WHERE status = 'closed'"))["s"] or 0

    # BTC5m stats
    btc5m_open  = (await fetchone(db, "SELECT COUNT(*) AS n FROM btc5m_positions"))["n"]
    btc5m_wins  = (await fetchone(db, "SELECT COUNT(*) AS n FROM btc5m_trades WHERE status != 'open' AND pnl > 0"))["n"]
    btc5m_pnl   = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM btc5m_trades WHERE status != 'open'"))["s"] or 0

    # Arb stats
    arb_open    = (await fetchone(db, "SELECT COUNT(*) AS n FROM arb_trades WHERE status = 'open'"))["n"]
    arb_wins    = (await fetchone(db, "SELECT COUNT(*) AS n FROM arb_trades WHERE status = 'closed' AND pnl > 0"))["n"]
    arb_pnl     = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM arb_trades WHERE status = 'closed'"))["s"] or 0
    arb_active_opps = (await fetchone(db, "SELECT COUNT(*) AS n FROM arb_opportunities WHERE status = 'open'"))["n"]
    arb_avg_profit = (await fetchone(db, "SELECT AVG(expected_profit) AS v FROM arb_opportunities WHERE status = 'open'"))["v"]

    # Grid BTC stats
    grid_pnl      = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM grid_trades"))["s"] or 0
    grid_wins     = (await fetchone(db, "SELECT COUNT(*) AS n FROM grid_trades WHERE pnl > 0"))["n"]
    grid_win_rate = round(grid_wins / grid_trades * 100, 1) if grid_trades > 0 else 0
    grid_active   = (await fetchone(db, "SELECT COUNT(*) AS n FROM grid_orders WHERE status IN ('pending','bought')"))["n"]
    grid_bought   = (await fetchone(db, "SELECT COUNT(*) AS n FROM grid_orders WHERE status='bought'"))["n"]

    # Grid PEPE stats
    pepe_pnl      = (await fetchone(db, "SELECT COALESCE(SUM(pnl), 0) AS s FROM pepe_grid_trades"))["s"] or 0
    pepe_wins     = (await fetchone(db, "SELECT COUNT(*) AS n FROM pepe_grid_trades WHERE pnl > 0"))["n"]
    pepe_win_rate = round(pepe_wins / pepe_trades * 100, 1) if pepe_trades > 0 else 0
    pepe_active   = (await fetchone(db, "SELECT COUNT(*) AS n FROM pepe_grid_orders WHERE status IN ('pending','bought')"))["n"]
    pepe_bought   = (await fetchone(db, "SELECT COUNT(*) AS n FROM pepe_grid_orders WHERE status='bought'"))["n"]

    # Active wallets
    active_wallets = await fetchall(
        db, "SELECT address, win_rate, roi, score, name FROM wallets WHERE active = 1 ORDER BY score DESC"
    )

    return {
        "bankroll":         bankroll,          # cash libre
        "portfolio_total":  portfolio_total,   # bankroll + capital_active
        "initial_bankroll": CONFIG.paper_bankroll,
        "pnl_total":        portfolio_total - CONFIG.paper_bankroll,
        "pnl_total_pct":    ((portfolio_total - CONFIG.paper_bankroll) / CONFIG.paper_bankroll) * 100,
        "pnl_day":          pnl_day,
        "win_rate":         win_rate,
        "open_positions":   copy_open + btc5m_open + arb_open + grid_active,
        "capital_active":   capital_active,
        "capital_copy":     copy_active,
        "capital_btc5m":    btc5m_active,
        "capital_grid":     grid_capital,
        "capital_pepe":     pepe_capital,
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
        "active_wallets": active_wallets,
        "last_updated":   (snap or {}).get("created_at"),
    }
