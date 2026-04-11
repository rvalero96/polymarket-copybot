import { getWalletTrades, getWalletPnL } from '../services/polymarket/api.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { DISCOVERY } = CONFIG;

// Wallets de traders conocidos en Polymarket — añade más aquí
const SEED_WALLETS = [
  '0x8b8d7b5f3e2a1c4d6e9f0b3a7c5d2e8f1a4b6c',
  '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a',
  '0x9f8e7d6c5b4a3928171615141312111009080706',
];

async function main() {
  logger.info('discovery:start');
  const db = await getDb();

  const candidates = SEED_WALLETS;
  logger.info('discovery:candidates', { count: candidates.length });

  const scored = [];
  for (const address of candidates) {
    try {
      const score = await scoreWallet(address);
      if (score) scored.push(score);
      else logger.info('discovery:skip', { address, reason: 'below threshold' });
    } catch (err) {
      logger.warn('discovery:score error', { address, error: err.message });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const newRoster = scored.slice(0, DISCOVERY.ROSTER_SIZE);

  run(db, `UPDATE wallets SET active = 0`);
  for (const w of newRoster) {
    run(db,
      `INSERT INTO wallets (address, added_at, active, win_rate, roi, score)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         active   = 1,
         win_rate = excluded.win_rate,
         roi      = excluded.roi,
         score    = excluded.score`,
      [w.address, Date.now(), w.win_rate, w.roi, w.score]
    );
    logger.info('discovery:roster:add', { address: w.address, score: w.score });
  }

  // Si no hay wallets que pasen el filtro, añade las seed directamente
  if (newRoster.length === 0) {
    logger.warn('discovery:no wallets passed filter, adding seeds directly');
    for (const address of SEED_WALLETS) {
      run(db,
        `INSERT INTO wallets (address, added_at, active, win_rate, roi, score)
         VALUES (?, ?, 1, 0.5, 0, 0.5)
         ON CONFLICT(address) DO UPDATE SET active = 1`,
        [address, Date.now()]
      );
    }
  }

  db.persist();
cat > src/discovery/ranker.js << 'EOF'
import { getWalletTrades, getWalletPnL } from '../services/polymarket/api.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { DISCOVERY } = CONFIG;

// Wallets de traders conocidos en Polymarket — añade más aquí
const SEED_WALLETS = [
  '0x8b8d7b5f3e2a1c4d6e9f0b3a7c5d2e8f1a4b6c',
  '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a',
  '0x9f8e7d6c5b4a3928171615141312111009080706',
];

async function main() {
  logger.info('discovery:start');
  const db = await getDb();

  const candidates = SEED_WALLETS;
  logger.info('discovery:candidates', { count: candidates.length });

  const scored = [];
  for (const address of candidates) {
    try {
      const score = await scoreWallet(address);
      if (score) scored.push(score);
      else logger.info('discovery:skip', { address, reason: 'below threshold' });
    } catch (err) {
      logger.warn('discovery:score error', { address, error: err.message });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const newRoster = scored.slice(0, DISCOVERY.ROSTER_SIZE);

  run(db, `UPDATE wallets SET active = 0`);
  for (const w of newRoster) {
    run(db,
      `INSERT INTO wallets (address, added_at, active, win_rate, roi, score)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         active   = 1,
         win_rate = excluded.win_rate,
         roi      = excluded.roi,
         score    = excluded.score`,
      [w.address, Date.now(), w.win_rate, w.roi, w.score]
    );
    logger.info('discovery:roster:add', { address: w.address, score: w.score });
  }

  // Si no hay wallets que pasen el filtro, añade las seed directamente
  if (newRoster.length === 0) {
    logger.warn('discovery:no wallets passed filter, adding seeds directly');
    for (const address of SEED_WALLETS) {
      run(db,
        `INSERT INTO wallets (address, added_at, active, win_rate, roi, score)
         VALUES (?, ?, 1, 0.5, 0, 0.5)
         ON CONFLICT(address) DO UPDATE SET active = 1`,
        [address, Date.now()]
      );
    }
  }

  db.persist();
  logger.info('discovery:done', { rosterSize: newRoster.length });
}

async function scoreWallet(address) {
  const [trades, pnl] = await Promise.all([
    getWalletTrades(address, 500),
    getWalletPnL(address),
  ]);

  const tradeList = trades?.data ?? trades ?? [];
  const closed    = tradeList.filter(t => t.type === 'Trade' && t.side === 'SELL');

  if (closed.length < DISCOVERY.MIN_CLOSED_POSITIONS) return null;

  const wins    = closed.filter(t => parseFloat(t.price) > parseFloat(t.avgPrice ?? 0.5));
  const winRate = wins.length / closed.length;
  if (winRate < DISCOVERY.MIN_WIN_RATE) return null;

  const roi = pnl?.roi ?? computeRoi(tradeList);
  if (roi < DISCOVERY.MIN_ROI) return null;

  const score = (winRate * 0.5) + (Math.min(roi, 2) / 2 * 0.3) + (Math.min(closed.length / 200, 1) * 0.2);
  return { address, win_rate: winRate, roi, closed_count: closed.length, score };
}

function computeRoi(trades) {
  let invested = 0, returned = 0;
  for (const t of trades) {
    if (t.side === 'BUY')  invested += parseFloat(t.usdcSize ?? 0);
    if (t.side === 'SELL') returned += parseFloat(t.usdcSize ?? 0);
  }
  return invested > 0 ? (returned - invested) / invested : 0;
}

main().catch(err => {
  logger.error('discovery:fatal', { error: err.message });
  process.exit(1);
});
