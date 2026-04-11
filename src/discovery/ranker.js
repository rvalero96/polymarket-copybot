import { getWalletPositions, getWalletTrades } from '../services/polymarket/api.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

const { DISCOVERY } = CONFIG;

// Wallets reales extraídas de polymarketanalytics.com/traders
// Actualiza desde: https://polymarket.com/leaderboard/overall/monthly/profit
const SEED_WALLETS = [
// Top 50 Polymarket Leaderboard - Monthly P/L (April 2026)
'0x492442eab586f242b53bda933fd5de859c8a3782', // #1  +$6.4M
'0x02227b8f5a9636e895607edd3185ed6ee5598ff7', // #2  HorizonSplendidView +$4.0M
'0xefbc5fec8d7b0acdc8911bdd9a98d6964308f9a2', // #3  reachingthesky +$3.7M
'0xc2e7800b5af46e6093872b177b7a5e7f0563be51', // #4  beachboy4 +$3.2M
'0x019782cab5d844f02bafb71f512758be78579f3c', // #5  majorexploiter +$2.4M
'0x2005d16a84ceefa912d4e380cd32e7ff827875ea', // #6  RN1 +$2.1M
'0xbddf61af533ff524d27154e589d2d7a81510c684', // #7  Countryside +$1.8M
'0xee613b3fc183ee44f9da9c05f53e2da107e3debf', // #8  sovereign2013 +$1.8M
'0x2a2c53bd278c04da9962fcf96490e17f3dfb9bc1', // #9  +$1.6M
'0x93abbc022ce98d6f45d4444b594791cc4b7a9723', // #10 gatorr +$1.5M
'0xdc876e6873772d38716fda7f2452a78d426d7ab6', // #11 432614799197 +$1.5M
'0xf195721ad850377c96cd634457c70cd9e8308057', // #12 lo34567Taipe +$1.5M
'0xc8075693f48668a264b9fa313b47f52712fcc12b', // #13 texaskid +$1.4M
'0xead152b855effa6b5b5837f53b24c0756830c76a', // #14 elkmonkey +$1.3M
'0x59a0744db1f39ff3afccd175f80e6e8dfc239a09', // #15 Blessed-Sunshine +$1.2M
'0x63a51cbb37341837b873bc29d05f482bc2988e33', // #16 mhh29 +$1.2M
'0x8f037a2e4fd49d11267f4ab874ab7ba745ac64d6', // #17 Anointed-Connect +$1.2M
'0x204f72f35326db932158cba6adff0b9a1da95e14', // #18 swisstony +$1.2M
'0xb6d6e99d3bfe055874a04279f659f009fd57be17', // #19 JPMorgan101 +$1.1M
'0xb45a797faa52b0fd8adc56d30382022b7b12192c', // #20 bcda +$973K
'0x2b3ff45c91540e46fae1e0c72f61f4b049453446', // #21 Mentallyillgambld +$963K
'0x777d9f00c2b4f7b829c9de0049ca3e707db05143', // #22 CarlosMC +$916K
'0x8c80d213c0cbad777d06ee3f58f6ca4bc03102c3', // #23 SecondWindCapital +$900K
'0x03e8a544e97eeff5753bc1e90d46e5ef22af1697', // #24 weflyhigh +$844K
'0xbaa2bcb5439e985ce4ccf815b4700027d1b92c73', // #25 denizz +$840K
'0xb90494d9a5d8f71f1930b2aa4b599f95c344c255', // #26 waterbottle6 +$816K
'0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee', // #27 kch123 +$797K
'0x07bdcabf60da99be8fad11092bf4e8412cffe993', // #28 imnotawizard +$737K
'0xde17f7144fbd0eddb2679132c10ff5e74b120988', // #29 +$727K
'0xa5ea13a81d2b7e8e424b182bdc1db08e756bd96a', // #30 bossoskil1 +$715K
'0x507e52ef684ca2dd91f90a9d26d149dd3288beae', // #31 GamblingIsAllYouNeed +$714K
'0xe90bec87d9ef430f27f9dcfe72c34b76967d5da2', // #32 gmanas +$679K
'0xd84c2b6d65dc596f49c7b6aadd6d74ca91e407b9', // #33 BoneReader +$614K
'0x036c159d5a348058a81066a76b89f35926d4178d', // #34 HedgeMaster88 +$590K
'0x916f7165c2c836aba22edb6453cdbb5f3ea253ba', // #35 WoofMaster +$571K
'0xd106952ebf30a3125affd8a23b6c1f30c35fc79c', // #36 Herdonia +$567K
'0xd0d6053c3c37e727402d84c14069780d360993aa', // #37 k9Q2mX4L8A7ZP3R +$536K
'0x63ce342161250d705dc0b16df89036c8e5f9ba9a', // #38 0x8dxd +$535K
'0xc6587b11a2209e46dfe3928b31c5514a8e33b784', // #39 Erasmus. +$507K
'0x0c0e270cf879583d6a0142fc817e05b768d0434e', // #40 The Spirit of Ukraine +$506K
'0xde7be6d489bce070a959e0cb813128ae659b5f4b', // #41 wan123 +$494K
'0x57cd939930fd119067ca9dc42b22b3e15708a0fb', // #42 Supah9ga +$491K
'0x6ade597c0e2b43c0bf3542cada8a5e330d73f5b0', // #43 TheOnlyHuman +$490K
'0x8a3ab8120807bd64a3de48695110e390fa2ceb9a', // #44 +$486K
'0x32ed517a571c01b6e9adecf61ba81ca48ff2f960', // #45 sportmaster777 +$470K
'0x7ea571c40408f340c1c8fc8eaacebab53c1bde7b', // #46 Cannae +$467K
'0x07921379f7b31ef93da634b688b2fe36897db778', // #47 ewelmealt +$459K
'0xd7375270e4769d3cc31885773070a5f12d5bbe95', // #48 Fernandoinfante +$458K
'0xb27bc932bf8110d8f78e55da7d5f0497a18b5b82', // #49 +$432K
'0xde9f03151fb0a4b8cbcf6bbe24b73bf5856bb8f7', // #50 sjqdhqsjgd65 +$427K
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
