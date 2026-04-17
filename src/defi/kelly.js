/**
 * Kelly Criterion — sizing dinámico del capital activo vs AAVE.
 *
 * Fórmula: f* = (p·b − q) / b
 *   p  = win rate histórico
 *   q  = 1 − p
 *   b  = ratio ganancia media / pérdida media  (odds)
 *   f* = fracción óptima del capital total a poner en riesgo
 *
 * El resto del capital (1 − f*) se mantiene en AAVE generando yield.
 *
 * ── Fases ─────────────────────────────────────────────────────────────────────
 *  Fase 1  (< MIN_TRADES_PHASE2):  sin edge validado → 100 % AAVE,
 *                                   solo se hace paper trading para acumular datos
 *  Fase 2  (< MIN_TRADES_PHASE3):  half-Kelly (50 % del tamaño recomendado)
 *                                   protege contra varianza de muestra pequeña
 *  Fase 3  (≥ MIN_TRADES_PHASE3):  full Kelly — edge validado estadísticamente
 *
 * En paper trading las fases afectan el tamaño de posición simulado pero no
 * bloquean los trades (necesitamos seguir acumulando datos de edge).
 */

import { CONFIG } from '../../config.js';
import { all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Lee todas las trades cerradas (copy + btc5m) y calcula:
 *   total, wins, avg_win, avg_loss, win_rate, b (odds ratio)
 */
export function computeKellyStats(db) {
  const copy = all(db, `
    SELECT
      COUNT(*)                                                  AS total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                AS wins,
      AVG(CASE WHEN pnl > 0 THEN pnl      ELSE NULL END)       AS avg_win,
      AVG(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE NULL END)       AS avg_loss
    FROM trades
    WHERE status = 'closed' AND pnl IS NOT NULL
  `)[0];

  const btc = all(db, `
    SELECT
      COUNT(*)                                                  AS total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                AS wins,
      AVG(CASE WHEN pnl > 0 THEN pnl      ELSE NULL END)       AS avg_win,
      AVG(CASE WHEN pnl < 0 THEN ABS(pnl) ELSE NULL END)       AS avg_loss
    FROM btc5m_trades
    WHERE status != 'open' AND pnl IS NOT NULL
  `)[0];

  // Combinar las dos estrategias ponderando por número de trades
  const total   = (copy.total ?? 0) + (btc.total ?? 0);
  const wins    = (copy.wins  ?? 0) + (btc.wins  ?? 0);

  // Avg win/loss: media ponderada (n × avg para cada estrategia)
  const copyWins  = copy.wins  ?? 0;
  const btcWins   = btc.wins   ?? 0;
  const copyLoss  = (copy.total ?? 0) - copyWins;
  const btcLoss   = (btc.total  ?? 0) - btcWins;

  const totalWins = copyWins + btcWins;
  const totalLoss = copyLoss + btcLoss;

  const avg_win = totalWins > 0
    ? ((copyWins * (copy.avg_win ?? 0)) + (btcWins * (btc.avg_win ?? 0))) / totalWins
    : null;

  const avg_loss = totalLoss > 0
    ? ((copyLoss * (copy.avg_loss ?? 0)) + (btcLoss * (btc.avg_loss ?? 0))) / totalLoss
    : null;

  const win_rate = total > 0 ? wins / total : null;
  const b        = (avg_win != null && avg_loss != null && avg_loss > 0)
    ? avg_win / avg_loss
    : null;

  return { total, wins, avg_win, avg_loss, win_rate, b, copy, btc };
}

/**
 * Determina la fase de Kelly según el número de trades cerrados y el modo.
 * @returns {1|2|3}
 */
export function getKellyPhase(totalTrades) {
  const { MIN_TRADES_PHASE2, MIN_TRADES_PHASE3 } = CONFIG.KELLY;
  if (totalTrades < MIN_TRADES_PHASE2) return 1;
  if (totalTrades < MIN_TRADES_PHASE3) return 2;
  return 3;
}

/**
 * Aplica la fórmula de Kelly: f* = (p·b − q) / b
 * Devuelve 0 si el edge es negativo (no operar).
 */
export function kellyFraction(p, b) {
  if (!p || !b || b <= 0) return 0;
  const q = 1 - p;
  return Math.max(0, (p * b - q) / b);
}

// ── API principal ─────────────────────────────────────────────────────────────

/**
 * Calcula la asignación óptima de capital entre trading activo y AAVE.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} portfolio  Valor total del portfolio (bankroll + posiciones abiertas)
 * @returns {{
 *   phase: 1|2|3,
 *   tradingFraction: number,   // fracción del portfolio para trading activo
 *   aaveFraction:   number,   // fracción del portfolio para AAVE
 *   tradingBudget:  number,   // USDC para trading activo
 *   aaveBudget:     number,   // USDC en AAVE
 *   rawKelly:       number,   // Kelly sin escalar
 *   multiplier:     number,   // 0 | 0.5 | 1.0
 *   positionSize:   number,   // USDC por posición individual
 *   stats:          object,
 * }}
 */
export function getKellyAllocation(db, portfolio) {
  const { HALF_KELLY_MULT, MAX_FRACTION, POSITIONS_IN_BUDGET } = CONFIG.KELLY;
  const stats = computeKellyStats(db);
  const phase = getKellyPhase(stats.total);

  // ── Fase 1: sin datos suficientes ─────────────────────────────────────────
  if (phase === 1 || stats.win_rate == null || stats.b == null) {
    const result = {
      phase: 1,
      tradingFraction: 0,
      aaveFraction:    1,
      tradingBudget:   0,
      aaveBudget:      portfolio,
      rawKelly:        0,
      multiplier:      0,
      positionSize:    0,
      stats,
    };
    logger.info('kelly:phase1', {
      totalTrades: stats.total,
      needed: CONFIG.KELLY.MIN_TRADES_PHASE2,
      note: 'accumulating edge data — 100% AAVE',
    });
    return result;
  }

  // ── Fase 2 / 3: edge con datos suficientes ────────────────────────────────
  const rawKelly   = kellyFraction(stats.win_rate, stats.b);
  const multiplier = phase === 2 ? HALF_KELLY_MULT : 1.0;
  const fraction   = Math.min(rawKelly * multiplier, MAX_FRACTION);

  const tradingBudget = portfolio * fraction;
  const aaveBudget    = portfolio * (1 - fraction);
  // Dividimos el trading budget entre el número de posiciones simultáneas
  const positionSize  = tradingBudget / POSITIONS_IN_BUDGET;

  const result = {
    phase,
    tradingFraction: fraction,
    aaveFraction:    1 - fraction,
    tradingBudget,
    aaveBudget,
    rawKelly,
    multiplier,
    positionSize,
    stats,
  };

  logger.info('kelly:allocation', {
    phase,
    p:              stats.win_rate?.toFixed(4),
    b:              stats.b?.toFixed(4),
    rawKelly:       (rawKelly * 100).toFixed(2) + '%',
    multiplier,
    fraction:       (fraction * 100).toFixed(2) + '%',
    tradingBudget:  tradingBudget.toFixed(2),
    aaveBudget:     aaveBudget.toFixed(2),
    positionSize:   positionSize.toFixed(2),
  });

  return result;
}

/**
 * Persiste un snapshot de la asignación Kelly en la tabla kelly_snapshots.
 * Se llama una vez por ciclo de trading para tener histórico de la evolución.
 */
export function saveKellySnapshot(db, portfolio, allocation) {
  run(db, `
    INSERT INTO kelly_snapshots
      (portfolio, phase, raw_kelly, multiplier, fraction, trading_budget,
       aave_budget, position_size, win_rate, odds_b, total_trades, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      portfolio,
      allocation.phase,
      allocation.rawKelly,
      allocation.multiplier,
      allocation.tradingFraction,
      allocation.tradingBudget,
      allocation.aaveBudget,
      allocation.positionSize,
      allocation.stats.win_rate,
      allocation.stats.b,
      allocation.stats.total,
      Date.now(),
    ]
  );
}

/**
 * Últimos N snapshots Kelly, para gráficos / dashboard.
 */
export function getKellyHistory(db, limit = 200) {
  return all(db,
    `SELECT * FROM kelly_snapshots ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
}
