/**
 * risk-manager.js — Position-level risk controls for copy trading.
 *
 * Runs at the start of every simulator cycle and closes positions that
 * breach any of the following thresholds (whichever triggers first):
 *
 *  1. TTL           – position age > MAX_POSITION_AGE_DAYS
 *  2. Stop-loss     – current price < entry price × (1 − STOP_LOSS_PCT)
 *  3. Inactivity    – price has not moved ≥ INACTIVITY_THRESHOLD_PCT
 *                     over the last INACTIVITY_DAYS days
 */

import { getMarket } from '../services/polymarket/api.js';
import { all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { FEE_PCT, COPY_TRADING } = CONFIG;
const {
  MAX_POSITION_AGE_DAYS,
  INACTIVITY_THRESHOLD_PCT,
  INACTIVITY_DAYS,
  STOP_LOSS_PCT,
} = COPY_TRADING;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse the current price for `outcome` from Gamma API market data.
 * Returns null if the market data is missing or malformed.
 */
function getCurrentPrice(market, outcome) {
  try {
    const outcomes = JSON.parse(market.outcomes ?? '[]');
    const prices   = JSON.parse(market.outcomePrices ?? '[]');
    const idx = outcomes.findIndex(
      o => o.toLowerCase() === outcome.toLowerCase()
    );
    return idx >= 0 ? parseFloat(prices[idx]) : null;
  } catch {
    return null;
  }
}

/**
 * Close a position at `closePrice`, update the matching trade record, free
 * the position slot and return the updated bankroll.
 */
function forceClose(db, pos, bankroll, reason, closePrice) {
  const price = closePrice ?? pos.avg_price;
  const pnl   = pos.size_usdc * (price - pos.avg_price) / pos.avg_price;
  const fee   = pos.size_usdc * FEE_PCT;

  run(db,
    `UPDATE trades
     SET status = 'closed', pnl = ?, close_reason = ?
     WHERE market_id = ? AND outcome = ? AND status = 'open'`,
    [pnl - fee, reason, pos.market_id, pos.outcome]
  );
  run(db,
    `DELETE FROM positions
     WHERE market_id = ? AND outcome = ? AND wallet = ?`,
    [pos.market_id, pos.outcome, pos.wallet]
  );

  logger.info('risk-manager:closed', {
    reason,
    market:     pos.market_id,
    outcome:    pos.outcome,
    entry:      pos.avg_price,
    close:      price,
    pnl:        (pnl - fee).toFixed(4),
  });

  return bankroll + pos.size_usdc + pnl - fee;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Iterate over every open copy-trading position and apply risk rules.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} bankroll  Current paper bankroll in USDC.
 * @returns {Promise<number>} Updated bankroll after forced closes.
 */
export async function checkPositionRisks(db, bankroll) {
  const positions = all(db, `SELECT * FROM positions`);
  if (positions.length === 0) return bankroll;

  const now = Date.now();
  let closed = 0;

  for (const pos of positions) {
    try {
      // ── 1. TTL ────────────────────────────────────────────────────────────
      const ageDays = (now - pos.opened_at) / 86_400_000;
      if (ageDays > MAX_POSITION_AGE_DAYS) {
        const market     = await getMarket(pos.market_id);
        const closePrice = market ? getCurrentPrice(market, pos.outcome) : null;
        bankroll = forceClose(db, pos, bankroll, 'ttl', closePrice);
        closed++;
        continue;
      }

      // ── Fetch live price (needed for SL + inactivity) ─────────────────────
      const market = await getMarket(pos.market_id);
      if (!market) continue;

      const currentPrice = getCurrentPrice(market, pos.outcome);
      if (currentPrice == null) continue;

      // ── 2. Stop-loss ──────────────────────────────────────────────────────
      if (currentPrice < pos.avg_price * (1 - STOP_LOSS_PCT)) {
        bankroll = forceClose(db, pos, bankroll, 'stop-loss', currentPrice);
        closed++;
        continue;
      }

      // ── 3. Inactivity ─────────────────────────────────────────────────────
      const lastPrice  = pos.last_price      ?? pos.avg_price;
      const trackedAt  = pos.price_tracked_at ?? pos.opened_at;
      const priceMove  = Math.abs(currentPrice - lastPrice) / lastPrice;

      if (priceMove >= INACTIVITY_THRESHOLD_PCT) {
        // Meaningful move — reset the inactivity clock
        run(db,
          `UPDATE positions
           SET last_price = ?, price_tracked_at = ?
           WHERE market_id = ? AND outcome = ? AND wallet = ?`,
          [currentPrice, now, pos.market_id, pos.outcome, pos.wallet]
        );
      } else {
        const staleDays = (now - trackedAt) / 86_400_000;
        if (staleDays > INACTIVITY_DAYS) {
          bankroll = forceClose(db, pos, bankroll, 'inactivity', currentPrice);
          closed++;
        }
      }
    } catch (err) {
      logger.error('risk-manager:error', {
        market: pos.market_id,
        error:  err.message,
      });
    }
  }

  logger.info('risk-manager:scan', { checked: positions.length, closed });
  return bankroll;
}
