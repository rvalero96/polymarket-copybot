import { getWalletPositions, getMarket } from '../services/polymarket/api.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { FILTERS, COPY_TRADING } = CONFIG;
const { MAX_MARKET_DAYS_TO_RESOLVE } = COPY_TRADING;

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
      // For new positions, check that the market resolves soon enough
      const marketEndDate = await fetchMarketEndDate(pos.conditionId);
      if (marketEndDate === null) {
        // Could not determine end date — skip to be safe
        logger.warn('signals:skipped-no-end-date', { market: pos.conditionId });
        continue;
      }
      const daysToResolve = (marketEndDate - Date.now()) / 86_400_000;
      if (daysToResolve > MAX_MARKET_DAYS_TO_RESOLVE) {
        logger.info('signals:filtered-long-market', {
          market: pos.conditionId,
          daysToResolve: daysToResolve.toFixed(1),
          max: MAX_MARKET_DAYS_TO_RESOLVE,
        });
        continue;
      }
      const endDateIso = new Date(marketEndDate).toISOString().slice(0, 10);
      signals.push(insertSignal(db, { wallet, pos, action: 'open', now, market_end_date: endDateIso }));
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

/**
 * Returns the market end date as a Unix timestamp (ms), or null if unknown.
 */
async function fetchMarketEndDate(conditionId) {
  try {
    const market = await getMarket(conditionId);
    if (!market) return null;
    const raw = market.endDateIso ?? market.endDate ?? null;
    if (!raw) return null;
    const ts = new Date(raw).getTime();
    return isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

function shouldFilter(pos) {
  const price = pos.curPrice ?? pos.currentPrice ?? 0;
  return (
    price < FILTERS.MIN_SIGNAL_PRICE ||
    price > FILTERS.MAX_SIGNAL_PRICE
  );
}

function insertSignal(db, { wallet, pos, action, now, market_end_date = null }) {
  const signal = {
    wallet,
    market_id:       pos.conditionId,
    outcome:         pos.outcome,
    slug:            pos.eventSlug ?? null,
    action,
    price:           pos.curPrice ?? pos.currentPrice ?? 0,
    size:            pos.currentValue ?? pos.size ?? 0,
    detected_at:     now,
    market_end_date, // ISO date string or null; used by simulator when opening positions
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
