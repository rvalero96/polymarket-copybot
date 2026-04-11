import { getWalletPositions } from '../services/polymarket/api.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { FILTERS } = CONFIG;

export async function detectSignals() {
  const db = await getDb();
  const wallets = all(db, `SELECT address FROM wallets WHERE active = 1`);
  const signals = [];
  const now = Date.now();

  for (const { address } of wallets) {
    try {
      const positions = await getWalletPositions(address);
      const newSignals = await processWalletPositions(db, address, positions, now);
      signals.push(...newSignals);
    } catch (err) {
      logger.error('signals:wallet error', { address, error: err.message });
    }
  }

  db.persist();
  logger.info('signals:detected', { count: signals.length });
  return signals;
}

async function processWalletPositions(db, wallet, positions, now) {
  const signals = [];

  const currentPos = new Map(
    (positions ?? []).map(p => [`${p.conditionId}:${p.outcome}`, p])
  );

  const knownPos = new Map(
    all(db, `SELECT market_id, outcome, size_usdc FROM positions WHERE wallet = ?`, [wallet])
      .map(r => [`${r.market_id}:${r.outcome}`, r])
  );

  for (const [key, pos] of currentPos) {
    if (shouldFilter(pos)) continue;
    if (!knownPos.has(key)) {
      signals.push(insertSignal(db, { wallet, pos, action: 'open', now }));
    } else {
      const known = knownPos.get(key);
      if ((pos.currentValue ?? pos.size) > known.size_usdc * 1.1) {
        signals.push(insertSignal(db, { wallet, pos, action: 'increase', now }));
      }
    }
  }

  for (const [key, known] of knownPos) {
    if (!currentPos.has(key)) {
      const [market_id, outcome] = key.split(':');
      signals.push(insertSignal(db, {
        wallet,
        pos: { conditionId: market_id, outcome, currentPrice: 0, size: known.size_usdc },
        action: 'close',
        now,
      }));
    }
  }

  return signals;
}

function shouldFilter(pos) {
  const price = pos.curPrice ?? pos.currentPrice ?? 0;
  return (
    price < FILTERS.MIN_SIGNAL_PRICE ||
    price > FILTERS.MAX_SIGNAL_PRICE
  );
}

function insertSignal(db, { wallet, pos, action, now }) {
  const signal = {
    wallet,
    market_id:   pos.conditionId,
    outcome:     pos.outcome,
    action,
    price:       pos.curPrice ?? pos.currentPrice ?? 0,
    size:        pos.currentValue ?? pos.size ?? 0,
    detected_at: now,
  };
  run(db,
    `INSERT INTO signals (wallet, market_id, outcome, action, price, size, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [signal.wallet, signal.market_id, signal.outcome, signal.action,
     signal.price, signal.size, signal.detected_at]
  );
  logger.info('signal:new', { action, wallet, market: pos.conditionId, price: pos.curPrice ?? pos.currentPrice });
  return signal;
}
