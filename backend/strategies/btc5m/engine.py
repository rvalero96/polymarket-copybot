"""
BTC5m — motor para mercados binarios de 5 minutos (BTC/ETH/SOL/XRP).
Estrategia: early-bird-5m
"""

import re
import time
import json
import asyncio
from config import CONFIG
from db.connection import get_db, fetchall, fetchone, execute
from services.polymarket import get_market_by_slug, get_midpoint_price, get_5m_markets
from services.binance import fetch_spot_price, fetch_candles
from strategies.btc5m.early_bird import compute_rsi, compute_atr, generate_signal
from logger import logger

TAKE_PROFIT  = 0.15
STOP_LOSS    = -0.10
MAX_POSITIONS = 3
ENTRY_WINDOW_MS = 3 * 60 * 1000  # 3 minutos

ASSETS = [
    {"name": "BTC", "symbol": "BTCUSDT", "slug": "btc-updown-5m"},
    {"name": "ETH", "symbol": "ETHUSDT", "slug": "eth-updown-5m"},
    {"name": "SOL", "symbol": "SOLUSDT", "slug": "sol-updown-5m"},
    {"name": "XRP", "symbol": "XRPUSDT", "slug": "xrp-updown-5m"},
]


def _extract_price_to_beat(question: str) -> float | None:
    match = re.search(r'\$?([\d,]+(?:\.\d+)?)', question or "")
    if not match:
        return None
    value = float(match.group(1).replace(",", ""))
    return value if value >= 100 else None


def _start_of(market: dict) -> int:
    slug_ts_str = (market.get("slug") or "").split("-")[-1]
    try:
        slug_ts = int(slug_ts_str)
        if slug_ts > 1e9:
            return slug_ts * 1000
    except ValueError:
        pass
    raw = market.get("startDate") or market.get("startDateIso") or 0
    try:
        from datetime import datetime, timezone
        return int(datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return 0


def _end_of(market: dict) -> int:
    raw = market.get("endDate") or market.get("endDateIso") or 0
    try:
        from datetime import datetime, timezone
        return int(datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return 0


def _pick_target_market(markets: list[dict], now: int) -> dict | None:
    alive = [m for m in markets if _end_of(m) > now]
    alive.sort(key=_start_of)

    if not alive:
        return None

    in_window = next(
        (m for m in alive if _start_of(m) <= now and now - _start_of(m) < ENTRY_WINDOW_MS),
        None,
    )
    if in_window:
        return in_window

    return next((m for m in alive if _start_of(m) > now), None)


def _close_position(db, pos: dict, exit_price: float, reason: str) -> float:
    # Nota: esta función es síncrona helper; se llama dentro de corrutinas con await execute
    pnl = pos["size_usdc"] * (exit_price - pos["entry_price"]) / pos["entry_price"]
    fee = pos["size_usdc"] * CONFIG.fee_pct
    return pos["size_usdc"] + pnl - fee, pnl - fee


async def _settle_positions(db) -> float:
    positions = await fetchall(db, "SELECT * FROM btc5m_positions")
    if not positions:
        return 0.0

    logger.info("btc5m:settle", {"open": len(positions)})
    recovered = 0.0
    now_ms = int(time.time() * 1000)

    for pos in positions:
        try:
            window_ts = (pos["opened_at"] // 1000 // 300) * 300
            slug = f"{pos['asset'].lower()}-updown-5m-{window_ts}"
            market = await get_market_by_slug(slug)
            if not market:
                continue

            if market.get("closed") or not market.get("active"):
                outcome_idx = 0 if pos["outcome"] == "UP" else 1
                raw_prices  = market.get("outcomePrices") or []
                prices      = json.loads(raw_prices) if isinstance(raw_prices, str) else raw_prices
                final_price = float(prices[outcome_idx]) if outcome_idx < len(prices) and prices[outcome_idx] is not None else (1.0 if market.get("winner") == pos["outcome"] else 0.01)

                capital, pnl = _close_position(db, pos, final_price, "resolved")

                await execute(db,
                    "UPDATE btc5m_trades SET status = ?, exit_price = ?, pnl = ?, closed_at = ? WHERE market_id = ? AND outcome = ? AND status = 'open'",
                    ("resolved", final_price, pnl, now_ms, pos["market_id"], pos["outcome"]),
                )
                await execute(db,
                    "DELETE FROM btc5m_positions WHERE market_id = ? AND outcome = ?",
                    (pos["market_id"], pos["outcome"]),
                )
                logger.info("btc5m:close", {
                    "asset": pos["asset"], "market": pos["market_id"], "outcome": pos["outcome"],
                    "entry": pos["entry_price"], "exit": final_price,
                    "pnl": f"{pnl:.4f}", "reason": "resolved",
                })
                recovered += capital
                continue

            if pos.get("token_id"):
                mid = await get_midpoint_price(pos["token_id"])
                if mid > 0:
                    pnl_pct = (mid - pos["entry_price"]) / pos["entry_price"]
                    if pnl_pct >= TAKE_PROFIT:
                        reason = "tp"
                    elif pnl_pct <= STOP_LOSS:
                        reason = "sl"
                    else:
                        continue

                    capital, pnl = _close_position(db, pos, mid, reason)
                    await execute(db,
                        "UPDATE btc5m_trades SET status = ?, exit_price = ?, pnl = ?, closed_at = ? WHERE market_id = ? AND outcome = ? AND status = 'open'",
                        (reason, mid, pnl, now_ms, pos["market_id"], pos["outcome"]),
                    )
                    await execute(db,
                        "DELETE FROM btc5m_positions WHERE market_id = ? AND outcome = ?",
                        (pos["market_id"], pos["outcome"]),
                    )
                    logger.info("btc5m:close", {
                        "asset": pos["asset"], "market": pos["market_id"], "outcome": pos["outcome"],
                        "entry": pos["entry_price"], "exit": mid,
                        "pnl": f"{pnl:.4f}", "reason": reason,
                    })
                    recovered += capital

        except Exception as err:
            logger.warn("btc5m:settle-error", {"market_id": pos["market_id"], "error": str(err)})

    return recovered


async def _process_asset(db, asset: dict, bankroll: float, now: int) -> float:
    name   = asset["name"]
    symbol = asset["symbol"]
    slug   = asset["slug"]

    try:
        spot_price, candles = await asyncio.gather(
            fetch_spot_price(symbol),
            fetch_candles(symbol, "1m", 20),
        )
    except Exception as err:
        logger.warn("btc5m:binance-error", {"asset": name, "error": str(err)})
        return 0.0

    closes = [c["close"] for c in candles]
    rsi    = compute_rsi(closes)
    atr    = compute_atr(candles)

    logger.info("btc5m:indicators", {
        "asset": name,
        "spot_price": spot_price,
        "rsi": f"{rsi:.2f}" if rsi is not None else "n/a",
        "atr": f"{atr:.4f}" if atr is not None else "n/a",
    })

    markets = await get_5m_markets(slug)
    if not markets:
        logger.info("btc5m:no-markets", {"asset": name})
        return 0.0

    target = _pick_target_market(markets, now)
    if not target:
        logger.info("btc5m:no-target-market", {"asset": name})
        return 0.0

    target_start = _start_of(target)
    if target_start > now:
        logger.info("btc5m:market-not-started", {"asset": name, "starts_in": f"{(target_start - now) // 1000}s"})
        return 0.0

    existing = await fetchall(db, "SELECT 1 FROM btc5m_positions WHERE market_id = ?", (target["conditionId"],))
    if existing:
        logger.info("btc5m:already-in-market", {"asset": name, "market": target["conditionId"]})
        return 0.0

    price_to_beat = _extract_price_to_beat(target.get("question") or "")

    raw_prices = target.get("outcomePrices") or []
    prices     = json.loads(raw_prices) if isinstance(raw_prices, str) else raw_prices
    up_price   = float(prices[0]) if len(prices) > 0 and prices[0] is not None else None
    down_price = float(prices[1]) if len(prices) > 1 and prices[1] is not None else None

    signal = generate_signal(spot_price, price_to_beat, rsi, atr, up_price, down_price)
    if not signal:
        logger.info("btc5m:no-signal", {
            "asset": name,
            "rsi": f"{rsi:.2f}" if rsi else None,
            "spot_price": spot_price,
            "price_to_beat": price_to_beat,
            "up_price": up_price,
            "down_price": down_price,
        })
        return 0.0

    open_count = (await fetchone(db, "SELECT COUNT(*) AS n FROM btc5m_positions"))["n"]
    if open_count >= MAX_POSITIONS:
        logger.warn("btc5m:max-positions", {"open_count": open_count, "max": MAX_POSITIONS})
        return 0.0

    # Entrar en posición
    outcome      = signal["outcome"]
    size_usdc    = bankroll * CONFIG.position_size_pct
    outcome_idx  = 0 if outcome == "UP" else 1

    raw_token_ids = target.get("clobTokenIds") or []
    token_ids     = json.loads(raw_token_ids) if isinstance(raw_token_ids, str) else raw_token_ids
    token_id      = token_ids[outcome_idx] if outcome_idx < len(token_ids) else None

    raw_price     = float(prices[outcome_idx]) if outcome_idx < len(prices) and prices[outcome_idx] is not None else 0.5
    eff_price     = raw_price * (1 + CONFIG.slippage_pct)
    fee           = size_usdc * CONFIG.fee_pct
    slippage      = size_usdc * CONFIG.slippage_pct

    market_title = target.get("question") or None
    market_slug  = target.get("slug") or None

    await execute(db,
        "INSERT OR IGNORE INTO btc5m_positions (market_id, outcome, asset, size_usdc, entry_price, token_id, slug, title, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (target["conditionId"], outcome, name, size_usdc, eff_price, token_id, market_slug, market_title, now),
    )
    await execute(db,
        "INSERT INTO btc5m_trades (market_id, asset, outcome, side, size_usdc, entry_price, fee, slippage, status, slug, title, opened_at) VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, 'open', ?, ?, ?)",
        (target["conditionId"], name, outcome, size_usdc, eff_price, fee, slippage, market_slug, market_title, now),
    )

    logger.info("btc5m:enter", {
        "asset": name,
        "market": target["conditionId"],
        "outcome": outcome,
        "price": f"{eff_price:.4f}",
        "size": f"{size_usdc:.2f}",
    })

    return size_usdc + fee


async def run_btc5m() -> None:
    if CONFIG.trading_mode == "live":
        logger.error("btc5m:live-mode-not-supported — set TRADING_MODE=paper")
        return

    logger.info("btc5m:start", {"mode": CONFIG.trading_mode})
    db = await get_db()

    snap     = await fetchone(db, "SELECT bankroll FROM snapshots ORDER BY date DESC LIMIT 1")
    bankroll = (snap or {}).get("bankroll") or CONFIG.paper_bankroll

    recovered = await _settle_positions(db)
    now       = int(time.time() * 1000)
    current   = bankroll + recovered

    spent = 0.0
    for asset in ASSETS:
        try:
            spent += await _process_asset(db, asset, current - spent, now)
        except Exception as err:
            logger.error("btc5m:asset-error", {"asset": asset["name"], "error": str(err)})

    if recovered != 0 or spent > 0:
        today       = __import__("datetime").date.today().isoformat()
        new_bankroll = current - spent
        open_pos    = (await fetchone(db, "SELECT COUNT(*) AS n FROM positions"))["n"]
        snaps       = await fetchall(db, "SELECT * FROM snapshots ORDER BY date DESC LIMIT 2")
        day_start   = next((s["bankroll"] for s in snaps if s["date"] != today), CONFIG.paper_bankroll)

        copy  = await fetchone(db, "SELECT COUNT(*) AS total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins FROM trades WHERE status = 'closed' AND pnl IS NOT NULL")
        btc5m = await fetchone(db, "SELECT COUNT(*) AS total, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins FROM btc5m_trades WHERE status != 'open' AND pnl IS NOT NULL")
        total_trades = (copy["total"] or 0) + (btc5m["total"] or 0)
        win_rate     = ((copy["wins"] or 0) + (btc5m["wins"] or 0)) / total_trades if total_trades > 0 else 0.0

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
            today, new_bankroll,
            new_bankroll - day_start,
            new_bankroll - CONFIG.paper_bankroll,
            open_pos, win_rate,
            int(time.time() * 1000),
        ))
        logger.info("btc5m:bankroll-updated", {
            "before": f"{bankroll:.2f}",
            "after": f"{new_bankroll:.2f}",
            "recovered": f"{recovered:.2f}",
            "spent": f"{spent:.2f}",
        })

    logger.info("btc5m:done", {"bankroll": f"{current - spent:.2f}", "spent": f"{spent:.2f}"})
