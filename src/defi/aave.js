/**
 * AAVE v3 Polygon — yield simulation for idle USDC.
 *
 * In paper-trading mode: fetches the real on-chain USDC supply APY from AAVE's
 * public API and accrues the equivalent interest on the idle bankroll each cycle.
 *
 * In live mode (Phase 2): wire depositToAave() / withdrawFromAave() to actually
 * supply/withdraw USDC via the AAVE v3 Pool contract on Polygon.
 *
 * AAVE v3 Polygon contract addresses (for reference):
 *   Pool:           0x794a61358D6845594F94dc1DB02A252b5b4814aD
 *   USDC (native):  0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
 *   USDC.e:         0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
 */

import { CONFIG } from '../../config.js';
import { all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ── Data sources ──────────────────────────────────────────────────────────────
// Primary: DefiLlama yields API — free, no auth, covers all major DeFi protocols
// Fallback: CONFIG.AAVE.FALLBACK_APY
const DEFILLAMA_POOLS_API = 'https://yields.llama.fi/pools';

// DefiLlama pool IDs for AAVE v3 Polygon USDC (native USDC, highest TVL pool)
// Pool IDs are stable identifiers in DefiLlama's system.
const AAVE_V3_POLYGON_USDC_POOL = '1b8b4cdb-0728-42a8-bf13-2c8fea7427ee';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetches the current USDC supply APY on AAVE v3 Polygon via DefiLlama.
 * DefiLlama is a well-maintained, free public API that aggregates DeFi yields.
 *
 * Falls back to CONFIG.AAVE.FALLBACK_APY if the request fails.
 *
 * @returns {Promise<number>} APY as a decimal (e.g. 0.0181 = 1.81 %)
 */
export async function fetchUsdcSupplyApy() {
  // ── Attempt 1: DefiLlama — AAVE v3 Polygon USDC ──────────────────────────
  try {
    const res = await fetch(DEFILLAMA_POOLS_API, { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const { data } = await res.json();

      // First try the known stable pool ID, then fall back to name-matching
      let pool = data.find(p => p.pool === AAVE_V3_POLYGON_USDC_POOL);
      if (!pool) {
        // Fallback matcher: highest-TVL AAVE v3 Polygon USDC pool
        const candidates = data.filter(p =>
          p.project === 'aave-v3' &&
          p.chain   === 'Polygon' &&
          (p.symbol === 'USDC' || p.symbol === 'USDC.E')
        );
        pool = candidates.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))[0];
      }

      if (pool?.apy != null) {
        const apy = pool.apy / 100;   // DefiLlama returns APY as percentage (e.g. 1.81)
        if (apy > 0 && apy < 1) {
          logger.info('aave:apy-fetched', {
            source:  'defillama',
            pool:    pool.pool,
            symbol:  pool.symbol,
            tvl:     pool.tvlUsd,
            apy:     (apy * 100).toFixed(2) + '%',
          });
          return apy;
        }
      }
    }
  } catch (_) { /* fall through */ }

  // ── Fallback ──────────────────────────────────────────────────────────────
  const fallback = CONFIG.AAVE.FALLBACK_APY;
  logger.warn('aave:apy-fallback', { apy: (fallback * 100).toFixed(2) + '%' });
  return fallback;
}

/**
 * Applies AAVE yield to the idle cash portion of the bankroll.
 *
 * Idle cash = `bankroll` argument (the liquid balance not deployed in positions).
 * Yield = idleCash × (APY / (365×24)) × hoursElapsed.
 *
 * Records the accrual in `aave_yields` and returns the updated bankroll.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} bankroll  Current liquid USDC balance
 * @returns {Promise<number>} Updated bankroll after yield
 */
export async function applyAaveYield(db, bankroll) {
  const { MAX_YIELD_HOURS, MIN_IDLE_USDC } = CONFIG.AAVE;
  const now = Date.now();

  // Guard: don't apply yield on tiny balances
  if (bankroll < MIN_IDLE_USDC) {
    logger.info('aave:yield-skipped', { reason: 'bankroll too low', bankroll });
    return bankroll;
  }

  // Determine hours elapsed since last yield application
  const lastYield   = all(db, `SELECT created_at FROM aave_yields ORDER BY created_at DESC LIMIT 1`)[0];
  const lastAt      = lastYield?.created_at ?? (now - 2 * 60 * 60 * 1000);
  const hoursRaw    = (now - lastAt) / (1000 * 60 * 60);
  const hours       = Math.min(hoursRaw, MAX_YIELD_HOURS);

  // Skip if less than half an hour since last application (duplicate-run guard)
  if (hoursRaw < 0.5) {
    logger.info('aave:yield-skipped', { reason: 'too soon', hoursElapsed: hoursRaw.toFixed(2) });
    return bankroll;
  }

  const apy         = await fetchUsdcSupplyApy();
  const hourlyRate  = apy / (365 * 24);
  const yieldEarned = bankroll * hourlyRate * hours;

  run(db,
    `INSERT INTO aave_yields (amount, apy, idle_cash, hours, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [yieldEarned, apy, bankroll, hours, now]
  );

  logger.info('aave:yield-applied', {
    amount:   `+${yieldEarned.toFixed(4)} USDC`,
    apy:      (apy * 100).toFixed(2) + '%',
    idleCash: bankroll.toFixed(2),
    hours:    hours.toFixed(2),
  });

  return bankroll + yieldEarned;
}

/**
 * Returns total AAVE yield earned (lifetime) and today's yield.
 */
export function getAaveStats(db) {
  const today = new Date().toISOString().slice(0, 10);

  const total = all(db,
    `SELECT COALESCE(SUM(amount), 0) as total,
            COALESCE(AVG(apy), 0)    as avg_apy
     FROM aave_yields`
  )[0];

  const todayRow = all(db,
    `SELECT COALESCE(SUM(amount), 0) as amount
     FROM aave_yields
     WHERE date(created_at/1000, 'unixepoch') = ?`,
    [today]
  )[0];

  return {
    totalYield: total.total,
    avgApy:     total.avg_apy,
    todayYield: todayRow.amount,
  };
}
