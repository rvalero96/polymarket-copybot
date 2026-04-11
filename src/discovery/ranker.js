import { getWalletPositions, getWalletTrades } from '../services/polymarket/api.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { DISCOVERY } = CONFIG;

// Wallets reales extraídas de polymarketanalytics.com/traders
// Actualiza desde: https://polymarket.com/leaderboard/overall/monthly/profit
const SEED_WALLETS = [
  '0x63ce342161250d705dc0b16df89036c8e5f9ba9a', // 0x8dxd
  '0x006cc834cc092684f1b56626e23bedb3835c16ea',
  '0x492442eab586f242b53bda933fd5de859c8a3782',
  '0x45bc74efa620b45c02308acaecdff1f7c06f978b',
  '0xee00ba338c59557141789b127927a55f5cc5cea1', // S-Works
  '0xd0d6053c3c37e727402d84c14069780d360993aa',
  '0x594edb9112f526fa6a80b8f858a6379c8a2c1c11', // ColdMath
];

async function scoreWallet(address) {
  try {
    // /positions devuelve cashPnl y percentPnl por posición
    const [rawPositions, rawTrades] = await Promise.all([
      getWalletPositions(address),
      getWalletTrades(address, 500),
    ]);

    const positions = Array.isArray(rawPositions) ? rawPositions : (rawPositions?.data ?? []);
    const trades    = Array.isArray(rawTrades)    ? rawTrades    : (rawTrades?.data    ?? []);

    // Necesitamos actividad mínima
    if (trades.length < DISCOVERY.MIN_CLOSED_POSITIONS) {
      logger.debug('ranker:skip', { address, reason: 'not enough trades', count: trades.length });
      return null;
    }

    // Win rate desde posiciones abiertas (cashPnl > 0 = ganando)
    const posWithPnl = positions.filter(p => p.cashPnl !== undefined || p.percentPnl !== undefined);
    let wins = 0;
    let totalPnl = 0;
    let totalInvested = 0;

    for (const p of posWithPnl) {
      const pnl      = parseFloat(p.cashPnl    ?? 0);
      const invested = parseFloat(p.initialValue ?? p.totalBought ?? 0);
      totalPnl      += pnl;
      totalInvested += invested;
      if (pnl > 0) wins++;
    }

    // Si no hay posiciones con PnL, usar trade count como proxy
    const winRate = posWithPnl.length > 0 ? wins / posWithPnl.length : 0;
    const roi        = totalInvested > 0 ? totalPnl / totalInvested : 0;

    if (posWithPnl.length > 0 && winRate < DISCOVERY.MIN_WIN_RATE) {
      logger.debug('ranker:skip', { address, reason: 'low winRate', winRate: winRate.toFixed(3) });
      return null;
    }

    if (posWithPnl.length > 0 && roi < DISCOVERY.MIN_ROI) {
      logger.debug('ranker:skip', { address, reason: 'low ROI', roi: roi.toFixed(3) });
      return null;
    }

    const activityScore = Math.min(trades.length / 200, 1);
    const score = winRate * 0.4 + Math.min(Math.max(roi, 0), 2) * 0.3 + activityScore * 0.3;

    logger.info('ranker:scored', {
      address,
      winRate: winRate.toFixed(3),
      roi: roi.toFixed(3),
      trades: trades.length,
      openPositions: positions.length,
      score: score.toFixed(4),
    });

    return { address, winRate, roi, pnlTotal: totalPnl, score };
  } catch (err) {
    logger.warn('ranker:wallet error', { address, error: err.message });
    return null;
  }
}

async function main() {
  logger.info('ranker:start', { candidates: SEED_WALLETS.length });
  const db  = await getDb();
  const now = Date.now();

  const settled = await Promise.allSettled(SEED_WALLETS.map(scoreWallet));

  let added   = 0;
  let updated = 0;

  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const { address, winRate, roi, pnlTotal, score } = result.value;

    const exists = all(db, `SELECT address FROM wallets WHERE address = ?`, [address])[0];

    if (exists) {
      run(db,
        `UPDATE wallets SET win_rate = ?, roi = ?, pnl_total = ?, score = ? WHERE address = ?`,
        [winRate, roi, pnlTotal, score, address],
      );
      updated++;
    } else {
      run(db,
        `INSERT INTO wallets (address, added_at, active, win_rate, roi, pnl_total, score)
         VALUES (?, ?, 1, ?, ?, ?, ?)`,
        [address, now, winRate, roi, pnlTotal, score],
      );
      added++;
    }
  }

  // Mantener solo los top ROSTER_SIZE activos
  const allWallets = all(db, `SELECT address FROM wallets ORDER BY score DESC`);
  for (let i = 0; i < allWallets.length; i++) {
    run(db,
      `UPDATE wallets SET active = ? WHERE address = ?`,
      [i < DISCOVERY.ROSTER_SIZE ? 1 : 0, allWallets[i].address],
    );
  }

  logger.info('ranker:done', {
    added,
    updated,
    active: Math.min(allWallets.length, DISCOVERY.ROSTER_SIZE),
  });
}

main().catch(err => {
  logger.error('ranker:fatal', { error: err.message });
  process.exit(1);
});
