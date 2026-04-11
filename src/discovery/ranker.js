import { getWalletPositions, getWalletTrades } from '../services/polymarket/api.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { DISCOVERY } = CONFIG;

// Wallets reales extraídas de polymarketanalytics.com/traders
// Actualiza desde: https://polymarket.com/leaderboard/overall/monthly/profit
const SEED_WALLETS = [
'0x492442eab586f242b53bda933fd5de859c8a3782', // #1 - +$3M P/L
'0xc2e7800b5af46e6093872b177b7a5e7f0563be51', // #2 - beachboy4
'0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee', // #3 - kch123
'0x003932bc605249fbfeb9ea6c3e15ec6e868a6beb', // #4 - PuzzleTricker
'0xd25c72ac0928385610611c8148803dc717334d20', // #5 - FeatherLeather
'0xdb27bf2ac5d428a9c63dbc914611036855a6c56e', // #6 - DrPufferfish
'0x876426b52898c295848f56760dd24b55eda2604a', // #7 - +$1.5M P/L
'0x03e8a544e97eeff5753bc1e90d46e5ef22af1697', // #8 - weflyhigh
'0x96489abcb9f583d6835c8ef95ffc923d05a86825', // #9 - anoin123
'0x14964aefa2cd7caff7878b3820a690a03c5aa429', // #10 - gmpm
'0x1d8a377c5020f612ce63a0a151970df64baae842', // #11 - +$878K P/L
'0xd0b4c4c020abdc88ad9a884f999f3d8cff8ffed6', // #12 - MrSparklySimpsons
'0x9976874011b081e1e408444c579f48aa5b5967da', // #13 - BWArmageddon
'0x4bd74aef0ee5f1ec0718890f55c15f047e28373e', // #14 - tbs8t
'0x13414a77a4be48988851c73dfd824d0168e70853', // #15 - WOMENBESHOPPING
'0x63ce342161250d705dc0b16df89036c8e5f9ba9a', // #16 - 0x8dxd
'0x7744bfd749a70020d16a1fcbac1d064761c9999e', // #17 - chungguskhan
'0x91654fd592ea5339fc0b1b2f2b30bfffa5e75b98', // #18 - C.SIN
'0xccb290b1c145d1c95695d3756346bba9f1398586', // #19 - hioa
'0x9c16127eccf031df45461ef1e04b52ea286a09cb', // #20 - Vanchalkenstein
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
