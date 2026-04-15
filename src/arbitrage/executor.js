// Arbitrage executor — paper-trades qualifying opportunities from the scanner
// Both legs of each opportunity are opened atomically.
// Settlement: when a market resolves, closed_at is stamped and PnL is recorded.

import { scan }             from './scanner.js';
import { getMidpointPrice } from '../services/polymarket/api.js';
import { getDb, all, run }  from '../utils/db.js';
import { logger }           from '../utils/logger.js';
import { CONFIG }           from '../../config.js';

const { PAPER_BANKROLL, SLIPPAGE_PCT, FEE_PCT, ARB } = CONFIG;

// ── Bankroll helpers ──────────────────────────────────────────────────────────

function loadBankroll(db) {
  const snaps = all(db, `SELECT bankroll FROM snapshots ORDER BY date DESC LIMIT 1`);
  return snaps[0]?.bankroll ?? PAPER_BANKROLL;
}

function saveBankroll(db, bankroll) {
  const today = new Date().toISOString().slice(0, 10);
  run(db,
    `INSERT INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
     VALUES (?, ?, 0, ?, 0, NULL, ?)
     ON CONFLICT(date) DO UPDATE SET
       bankroll   = excluded.bankroll,
       pnl_total  = excluded.pnl_total,
       created_at = excluded.created_at`,
    [today, bankroll, bankroll - PAPER_BANKROLL, Date.now()]
  );
}

// ── Settlement ────────────────────────────────────────────────────────────────
// Check open arb trades and settle those whose markets have resolved.
// A resolved outcome token pays 1.0 (win) or 0.0 (loss) in USDC.

async function settleOpenTrades(db) {
  const openTrades = all(db,
    `SELECT at.*, ao.strategy
     FROM arb_trades at
     JOIN arb_opportunities ao ON at.opportunity_id = ao.id
     WHERE at.status = 'open'`
  );

  if (!openTrades.length) return 0;

  let bankroll  = loadBankroll(db);
  let settled   = 0;

  for (const trade of openTrades) {
    try {
      // Check current market price — if it hits 0.98+ or 0.02- it has effectively resolved
      const currentPrice = await getMidpointPrice(trade.market_id);

      let resolved  = false;
      let exitPrice = null;

      if (currentPrice >= 0.98) { resolved = true; exitPrice = 1.0; }  // outcome won
      if (currentPrice <= 0.02) { resolved = true; exitPrice = 0.0; }  // outcome lost

      if (!resolved) continue;

      const fee  = trade.size_usdc * FEE_PCT;
      const pnl  = trade.size_usdc * (exitPrice - trade.price) / trade.price - fee;

      run(db,
        `UPDATE arb_trades SET status = 'closed', pnl = ?, closed_at = ? WHERE id = ?`,
        [pnl, Date.now(), trade.id]
      );

      bankroll += trade.size_usdc + pnl;
      settled++;

      logger.info('arb:settle', { trade_id: trade.id, market: trade.market_id, outcome: trade.outcome, pnl });

      // Mark opportunity as resolved when ALL its legs are closed
      const remaining = all(db,
        `SELECT COUNT(*) as n FROM arb_trades WHERE opportunity_id = ? AND status = 'open'`,
        [trade.opportunity_id]
      )[0].n;

      if (remaining === 0) {
        run(db, `UPDATE arb_opportunities SET status = 'resolved' WHERE id = ?`, [trade.opportunity_id]);
      }
    } catch (err) {
      logger.warn('arb:settle:error', { trade_id: trade.id, error: err.message });
    }
  }

  if (settled > 0) saveBankroll(db, bankroll);
  return settled;
}

// ── Open new arb positions ────────────────────────────────────────────────────

async function openOpportunity(db, opp, bankroll) {
  const legs         = typeof opp.legs === 'string' ? JSON.parse(opp.legs) : opp.legs;
  const sizePerLeg   = bankroll * ARB.POSITION_SIZE_PCT;
  const totalCost    = sizePerLeg * legs.length;

  if (bankroll < totalCost) {
    logger.warn('arb:open:insufficient_bankroll', { need: totalCost, have: bankroll });
    return bankroll;
  }

  const now = Date.now();

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const effectivePrice = leg.price * (1 + SLIPPAGE_PCT);
    const fee            = sizePerLeg * FEE_PCT;
    const slippage       = sizePerLeg * SLIPPAGE_PCT;

    run(db,
      `INSERT INTO arb_trades
         (opportunity_id, leg_index, market_id, outcome, side, price, size_usdc, fee, slippage, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [opp.id, i, leg.market_id, leg.outcome, leg.side, effectivePrice, sizePerLeg, fee, slippage, now]
    );

    bankroll -= sizePerLeg + fee;
  }

  run(db, `UPDATE arb_opportunities SET status = 'traded' WHERE id = ?`, [opp.id]);
  logger.info('arb:open', { opportunity_id: opp.id, strategy: opp.strategy, legs: legs.length, size_per_leg: sizePerLeg });

  return bankroll;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('arb:executor:start');
  const db = await getDb();

  // 1. Settle any resolved positions first
  const settled = await settleOpenTrades(db);
  logger.info('arb:executor:settled', { count: settled });

  // 2. Scan for new opportunities
  await scan();

  // 3. Fetch qualifying open opportunities not yet traded
  const candidates = all(db,
    `SELECT * FROM arb_opportunities
     WHERE status = 'open'
       AND expected_profit >= ?
       AND confidence >= ?
     ORDER BY expected_profit DESC`,
    [ARB.MIN_PROFIT_PCT, ARB.MIN_CONFIDENCE]
  );

  if (!candidates.length) {
    logger.info('arb:executor:no_candidates');
    return;
  }

  // 4. Check open arb position count
  const openCount = all(db,
    `SELECT COUNT(DISTINCT opportunity_id) as n FROM arb_trades WHERE status = 'open'`
  )[0].n;

  if (openCount >= ARB.MAX_OPEN_POSITIONS) {
    logger.info('arb:executor:max_positions', { open: openCount, max: ARB.MAX_OPEN_POSITIONS });
    return;
  }

  let bankroll = loadBankroll(db);
  let opened   = 0;

  for (const opp of candidates) {
    if (openCount + opened >= ARB.MAX_OPEN_POSITIONS) break;
    try {
      bankroll = await openOpportunity(db, opp, bankroll);
      opened++;
    } catch (err) {
      logger.error('arb:executor:open_error', { opportunity_id: opp.id, error: err.message });
    }
  }

  saveBankroll(db, bankroll);
  logger.info('arb:executor:done', { opened, bankroll });
}

main().catch(err => {
  logger.error('arb:executor:fatal', { error: err.message });
  process.exit(1);
});
