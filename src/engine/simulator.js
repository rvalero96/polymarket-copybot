import { detectSignals } from './signals.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { POSITION_SIZE_PCT, PAPER_BANKROLL, SLIPPAGE_PCT, FEE_PCT, MAX_OPEN_POSITIONS } = CONFIG;

async function main() {
  logger.info('simulator:start', { mode: CONFIG.TRADING_MODE });
  const db = await getDb();

  if (CONFIG.TRADING_MODE === 'live') {
    logger.error('simulator:live mode not wired yet — set TRADING_MODE=paper');
    process.exit(1);
  }

  const signals = await detectSignals();
  if (signals.length === 0) {
    logger.info('simulator:no signals, done');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const snapshots = all(db, `SELECT * FROM snapshots ORDER BY date DESC LIMIT 2`);
  const todaySnap = snapshots.find(s => s.date === today);
  const prevSnap  = snapshots.find(s => s.date !== today);
  let bankroll = todaySnap?.bankroll ?? prevSnap?.bankroll ?? PAPER_BANKROLL;
  const dayStartBankroll = prevSnap?.bankroll ?? PAPER_BANKROLL;

  for (const signal of signals) {
    // Re-check limit each iteration: block opens but always allow closes
    if (signal.action === 'open' || signal.action === 'increase') {
      const openCount = all(db, `SELECT COUNT(*) as n FROM positions`)[0].n;
      if (openCount >= MAX_OPEN_POSITIONS) {
        logger.warn('simulator:max positions reached, skipping open', { openCount, max: MAX_OPEN_POSITIONS });
        continue;
      }
    }
    try {
      bankroll = await executeSignal(db, signal, bankroll);
    } catch (err) {
      logger.error('simulator:signal error', { signal, error: err.message });
    }
  }

  // Persist updated bankroll so the next run reads the correct value
  const openPositionCount = all(db, `SELECT COUNT(*) as n FROM positions`)[0].n;
  run(db,
    `INSERT INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(date) DO UPDATE SET
       bankroll       = excluded.bankroll,
       pnl_day        = excluded.pnl_day,
       pnl_total      = excluded.pnl_total,
       open_positions = excluded.open_positions,
       created_at     = excluded.created_at`,
    [today, bankroll, bankroll - dayStartBankroll, bankroll - PAPER_BANKROLL, openPositionCount, Date.now()]
  );

  logger.info('simulator:done', { bankroll });
}

async function executeSignal(db, signal, bankroll) {
  const now = Date.now();

  if (signal.action === 'open' || signal.action === 'increase') {
    const sizeUsdc = bankroll * POSITION_SIZE_PCT;
    const slippage = sizeUsdc * SLIPPAGE_PCT;
    const fee      = sizeUsdc * FEE_PCT;
    const effectivePrice = signal.price * (1 + SLIPPAGE_PCT);

    const slug = signal.slug ?? null;

    run(db,
      `INSERT INTO trades (market_id, outcome, side, size_usdc, price, fee, slippage, executed_at)
       VALUES (?, ?, 'buy', ?, ?, ?, ?, ?)`,
      [signal.market_id, signal.outcome, sizeUsdc, effectivePrice, fee, slippage, now]
    );

    run(db,
      `INSERT INTO positions (market_id, outcome, wallet, avg_price, size_usdc, slug, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(market_id, outcome, wallet)
       DO UPDATE SET
         avg_price = (avg_price * size_usdc + excluded.avg_price * excluded.size_usdc)
                     / (size_usdc + excluded.size_usdc),
         size_usdc = size_usdc + excluded.size_usdc,
         slug      = COALESCE(excluded.slug, positions.slug)`,
      [signal.market_id, signal.outcome, signal.wallet, effectivePrice, sizeUsdc, slug, now]
    );

    logger.info('trade:open', { market: signal.market_id, size: sizeUsdc, price: effectivePrice });
    return bankroll - sizeUsdc - fee;
  }

  if (signal.action === 'close') {
    const pos = all(db,
      `SELECT * FROM positions WHERE market_id = ? AND outcome = ? AND wallet = ?`,
      [signal.market_id, signal.outcome, signal.wallet]
    )[0];

    if (!pos) return bankroll;

    const closePrice = signal.price || pos.avg_price;
    const pnl        = pos.size_usdc * (closePrice - pos.avg_price) / pos.avg_price;
    const fee        = pos.size_usdc * FEE_PCT;

    run(db, `UPDATE trades SET status = 'closed' WHERE market_id = ? AND outcome = ?`,
      [signal.market_id, signal.outcome]);
    run(db, `DELETE FROM positions WHERE market_id = ? AND outcome = ? AND wallet = ?`,
      [signal.market_id, signal.outcome, signal.wallet]);

    logger.info('trade:close', { market: signal.market_id, pnl, fee });
    return bankroll + pos.size_usdc + pnl - fee;
  }

  return bankroll;
}

main().catch(err => {
  logger.error('simulator:fatal', { error: err.message });
  process.exit(1);
});
