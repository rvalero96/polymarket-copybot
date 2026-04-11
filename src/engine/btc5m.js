// btc5m — motor para mercados binarios de 5 minutos (BTC/ETH/SOL/XRP)
// Estrategia: early-bird-5m
// Ejecutado cada 5 minutos desde GitHub Actions

import fetch from 'node-fetch';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';
import { computeRSI, computeATR, generateSignal } from '../strategies/early-bird.js';
import { getMarketBySlug, getMidpointPrice, get5mMarkets } from '../services/polymarket/api.js';

// api.binance.com bloquea IPs de EEUU (GitHub Actions) con 451
const BINANCE_BASE = 'https://api.binance.us/api/v3';

const STRATEGY = {
  POSITION_SIZE_PCT: CONFIG.POSITION_SIZE_PCT,  // 5% del bankroll por trade
  TAKE_PROFIT:  0.15,   // cerrar si profit >= 15%
  STOP_LOSS:   -0.10,   // cerrar si loss <= -10%
  MAX_POSITIONS: 3,     // máximo de posiciones btc5m abiertas simultáneas
  // Ventana de entrada: mercado debe haber empezado hace menos de X ms
  ENTRY_WINDOW_MS: 3 * 60 * 1000,  // 3 minutos tras el inicio del mercado
  ASSETS: [
    { name: 'BTC', symbol: 'BTCUSDT', slug: 'btc-updown-5m' },
    { name: 'ETH', symbol: 'ETHUSDT', slug: 'eth-updown-5m' },
    { name: 'SOL', symbol: 'SOLUSDT', slug: 'sol-updown-5m' },
    { name: 'XRP', symbol: 'XRPUSDT', slug: 'xrp-updown-5m' },
  ],
};

// ── Binance helpers ──────────────────────────────────────────────────────────

async function fetchSpotPrice(symbol) {
  const res = await fetch(`${BINANCE_BASE}/ticker/price?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance price ${res.status}`);
  const data = await res.json();
  return parseFloat(data.price);
}

async function fetchCandles(symbol, interval = '1m', limit = 20) {
  const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  const raw = await res.json();
  // Binance kline: [openTime, open, high, low, close, ...]
  return raw.map(k => ({
    open:  parseFloat(k[1]),
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

// ── Market helpers ───────────────────────────────────────────────────────────

// Extrae el precio umbral de la pregunta del mercado
// Ej: "Will BTC be above $82,000?" → 82000
// Ej: "Bitcoin Up or Down - April 11, ..." → null (no hay umbral)
function extractPriceToBeat(question = '') {
  const match = question.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ''));
  // Descartar números pequeños (días del mes, horas, etc.)
  if (value < 100) return null;
  return value;
}

function startOf(m) {
  // 5m markets encode the window start as a Unix timestamp at the end of the slug
  // e.g. "btc-updown-5m-1775931000" → 1775931000 * 1000 ms
  // startDate is the market creation date, not the window start — ignore it
  const slugTs = parseInt((m.slug ?? '').split('-').pop(), 10);
  if (!isNaN(slugTs) && slugTs > 1e9) return slugTs * 1000;
  return new Date(m.startDate ?? m.startDateIso ?? 0).getTime();
}

function endOf(m) {
  return new Date(m.endDate ?? m.endDateIso ?? 0).getTime();
}

// Devuelve el mercado objetivo: el siguiente que aún no ha cerrado,
// priorizando el que acaba de entrar en "run" (dentro de la ventana de entrada)
function pickTargetMarket(markets, now) {
  const alive = markets
    .filter(m => endOf(m) > now)
    .sort((a, b) => startOf(a) - startOf(b));

  if (alive.length === 0) return null;

  // Buscar el que acaba de arrancar y todavía está en ventana de entrada
  const inWindow = alive.find(m => {
    const start = startOf(m);
    return start <= now && now - start < STRATEGY.ENTRY_WINDOW_MS;
  });
  if (inWindow) return inWindow;

  // Si no hay ninguno en ventana, devolver el próximo que va a arrancar
  return alive.find(m => startOf(m) > now) ?? null;
}

// ── Settle: cerrar posiciones resueltas o que han tocado TP/SL ──────────────

// Retorna el capital recuperado: size_usdc + pnl - fee
function closeBtc5mPosition(db, pos, exitPrice, reason) {
  const now = Date.now();
  const pnl = pos.size_usdc * (exitPrice - pos.entry_price) / pos.entry_price;
  const fee = pos.size_usdc * CONFIG.FEE_PCT;

  run(db,
    `UPDATE btc5m_trades
     SET status = ?, exit_price = ?, pnl = ?, closed_at = ?
     WHERE market_id = ? AND outcome = ? AND status = 'open'`,
    [reason, exitPrice, pnl - fee, now, pos.market_id, pos.outcome],
  );

  run(db,
    `DELETE FROM btc5m_positions WHERE market_id = ? AND outcome = ?`,
    [pos.market_id, pos.outcome],
  );

  logger.info('btc5m:close', {
    asset: pos.asset, market: pos.market_id, outcome: pos.outcome,
    entry: pos.entry_price, exit: exitPrice,
    pnl: (pnl - fee).toFixed(4), reason,
  });

  return pos.size_usdc + pnl - fee;
}

// Retorna el capital neto recuperado de todas las posiciones cerradas
async function settlePositions(db) {
  const positions = all(db, `SELECT * FROM btc5m_positions`);
  if (positions.length === 0) return 0;

  logger.info('btc5m:settle', { open: positions.length });

  let recovered = 0;

  for (const pos of positions) {
    try {
      const windowTs = Math.floor(pos.opened_at / 1000 / 300) * 300;
      const slug = `${pos.asset.toLowerCase()}-updown-5m-${windowTs}`;
      const market = await getMarketBySlug(slug);
      if (!market) continue;

      if (market.closed || !market.active) {
        const outcomeIdx = pos.outcome === 'UP' ? 0 : 1;
        const rawPrices = market.outcomePrices ?? [];
        const prices = typeof rawPrices === 'string' ? JSON.parse(rawPrices) : rawPrices;
        const finalPrice = prices[outcomeIdx] != null
          ? parseFloat(prices[outcomeIdx])
          : (market.winner === pos.outcome ? 1.0 : 0.01);

        recovered += closeBtc5mPosition(db, pos, finalPrice, 'resolved');
        continue;
      }

      if (pos.token_id) {
        const mid = await getMidpointPrice(pos.token_id);
        if (mid > 0) {
          const pnlPct = (mid - pos.entry_price) / pos.entry_price;
          if (pnlPct >= STRATEGY.TAKE_PROFIT) {
            recovered += closeBtc5mPosition(db, pos, mid, 'tp');
          } else if (pnlPct <= STRATEGY.STOP_LOSS) {
            recovered += closeBtc5mPosition(db, pos, mid, 'sl');
          }
        }
      }
    } catch (err) {
      logger.warn('btc5m:settle-error', { market_id: pos.market_id, error: err.message });
    }
  }

  return recovered;
}

// ── Enter: abrir nueva posición ──────────────────────────────────────────────

function enterPosition(db, asset, market, outcome, bankroll, now) {
  const sizeUsdc   = bankroll * STRATEGY.POSITION_SIZE_PCT;
  const outcomeIdx = outcome === 'UP' ? 0 : 1;

  const rawTokenIds = market.clobTokenIds ?? [];
  const tokenIds = typeof rawTokenIds === 'string' ? JSON.parse(rawTokenIds) : rawTokenIds;
  const tokenId = tokenIds[outcomeIdx]
    ?? (Array.isArray(market.tokens) ? market.tokens[outcomeIdx]?.token_id : null)
    ?? null;

  const rawOutcomePrices = market.outcomePrices ?? [];
  const prices    = typeof rawOutcomePrices === 'string' ? JSON.parse(rawOutcomePrices) : rawOutcomePrices;
  const rawPrice  = prices[outcomeIdx] != null ? parseFloat(prices[outcomeIdx]) : 0.5;
  const effectivePrice = rawPrice * (1 + CONFIG.SLIPPAGE_PCT);
  const fee      = sizeUsdc * CONFIG.FEE_PCT;
  const slippage = sizeUsdc * CONFIG.SLIPPAGE_PCT;

  run(db,
    `INSERT OR IGNORE INTO btc5m_positions
       (market_id, outcome, asset, size_usdc, entry_price, token_id, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [market.conditionId, outcome, asset, sizeUsdc, effectivePrice, tokenId, now],
  );

  run(db,
    `INSERT INTO btc5m_trades
       (market_id, asset, outcome, side, size_usdc, entry_price, fee, slippage, status, opened_at)
     VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, 'open', ?)`,
    [market.conditionId, asset, outcome, sizeUsdc, effectivePrice, fee, slippage, now],
  );

  logger.info('btc5m:enter', {
    asset, market: market.conditionId, outcome,
    price: effectivePrice.toFixed(4), size: sizeUsdc.toFixed(2),
  });

  return sizeUsdc + fee;
}

// ── processAsset: lógica completa para un activo ─────────────────────────────

async function processAsset(db, asset, bankroll, now) {
  const { name, symbol, slug } = asset;

  // 1. Datos de precio desde Binance
  let spotPrice, candles;
  try {
    [spotPrice, candles] = await Promise.all([
      fetchSpotPrice(symbol),
      fetchCandles(symbol, '1m', 20),
    ]);
  } catch (err) {
    logger.warn('btc5m:binance-error', { asset: name, error: err.message });
    return 0;
  }

  const closes = candles.map(c => c.close);
  const rsi    = computeRSI(closes);
  const atr    = computeATR(candles);

  logger.info('btc5m:indicators', {
    asset: name, spotPrice,
    rsi: rsi?.toFixed(2) ?? 'n/a',
    atr: atr?.toFixed(4) ?? 'n/a',
  });

  // 2. Buscar mercados de 5 minutos activos
  const markets = await get5mMarkets(slug);
  if (markets.length === 0) {
    logger.info('btc5m:no-markets', { asset: name });
    return 0;
  }

  // 3. Seleccionar el mercado objetivo: solo entrar si está dentro de la ventana de entrada
  const target = pickTargetMarket(markets, now);
  if (!target) {
    logger.info('btc5m:no-target-market', { asset: name });
    return 0;
  }
  const targetStart = startOf(target);
  if (targetStart > now) {
    logger.info('btc5m:market-not-started', { asset: name, startsIn: Math.round((targetStart - now) / 1000) + 's' });
    return 0;
  }

  // 4. No entrar si ya tenemos posición en este mercado
  const existing = all(db,
    `SELECT 1 FROM btc5m_positions WHERE market_id = ?`,
    [target.conditionId],
  );
  if (existing.length > 0) {
    logger.info('btc5m:already-in-market', { asset: name, market: target.conditionId });
    return 0;
  }

  // 5. Extraer precio umbral del enunciado del mercado (null para mercados "Up or Down")
  const priceToBeat = extractPriceToBeat(target.question ?? '');

  // 6. Generar señal
  // outcomePrices y clobTokenIds llegan como string JSON desde la Gamma API
  const rawPrices = target.outcomePrices ?? [];
  const prices    = typeof rawPrices === 'string' ? JSON.parse(rawPrices) : rawPrices;
  const upPrice   = prices[0] != null ? parseFloat(prices[0]) : null;
  const downPrice = prices[1] != null ? parseFloat(prices[1]) : null;

  const signal = generateSignal({ spotPrice, priceToBeat, rsi, atr, upPrice, downPrice });
  if (!signal) {
    logger.info('btc5m:no-signal', {
      asset: name, rsi: rsi?.toFixed(2), spotPrice, priceToBeat,
      upPrice, downPrice, atrPct: atr ? ((atr / spotPrice) * 100).toFixed(4) : null,
    });
    return 0;
  }

  // 7. Comprobar límite de posiciones abiertas
  const openCount = all(db, `SELECT COUNT(*) as n FROM btc5m_positions`)[0].n;
  if (openCount >= STRATEGY.MAX_POSITIONS) {
    logger.warn('btc5m:max-positions', { openCount, max: STRATEGY.MAX_POSITIONS });
    return 0;
  }

  // 8. Entrar en la posición
  return enterPosition(db, name, target, signal.outcome, bankroll, now);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (CONFIG.TRADING_MODE === 'live') {
    logger.error('btc5m:live-mode-not-supported — set TRADING_MODE=paper');
    process.exit(1);
  }

  logger.info('btc5m:start', { mode: CONFIG.TRADING_MODE });
  const db  = await getDb();
  // Leer bankroll del último snapshot (compartido con copy-trading)
  const snap = all(db, `SELECT bankroll FROM snapshots ORDER BY date DESC LIMIT 1`)[0];
  const bankroll = snap?.bankroll ?? CONFIG.PAPER_BANKROLL;

  // Paso 1: cerrar posiciones resueltas / TP / SL y recuperar capital
  const recovered = await settlePositions(db);

  // Capturar now DESPUÉS del settle para que el cálculo de ventana sea preciso
  const nowAfterSettle = Date.now();

  // Bankroll actualizado con capital recuperado de cierres
  let currentBankroll = bankroll + recovered;

  // Paso 2: buscar entradas en cada activo
  let spent = 0;
  for (const asset of STRATEGY.ASSETS) {
    try {
      spent += await processAsset(db, asset, currentBankroll - spent, nowAfterSettle);
    } catch (err) {
      logger.error('btc5m:asset-error', { asset: asset.name, error: err.message });
    }
  }

  // Actualizar bankroll en el snapshot si hubo cambios (cierres o aperturas)
  if (recovered !== 0 || spent > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const newBankroll = currentBankroll - spent;
    const openPositions = all(db, `SELECT COUNT(*) as n FROM positions`)[0].n;
    const prevSnap = all(db, `SELECT * FROM snapshots ORDER BY date DESC LIMIT 2`);
    const dayStart = prevSnap.find(s => s.date !== today)?.bankroll ?? CONFIG.PAPER_BANKROLL;
    run(db,
      `INSERT INTO snapshots (date, bankroll, pnl_day, pnl_total, open_positions, win_rate, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(date) DO UPDATE SET
         bankroll       = excluded.bankroll,
         pnl_day        = excluded.pnl_day,
         pnl_total      = excluded.pnl_total,
         open_positions = excluded.open_positions,
         created_at     = excluded.created_at`,
      [today, newBankroll, newBankroll - dayStart, newBankroll - CONFIG.PAPER_BANKROLL, openPositions, Date.now()],
    );
    logger.info('btc5m:bankroll-updated', { before: bankroll.toFixed(2), after: newBankroll.toFixed(2), recovered: recovered.toFixed(2), spent: spent.toFixed(2) });
  }

  logger.info('btc5m:done', { bankroll: (currentBankroll - spent).toFixed(2), spent: spent.toFixed(2) });
}

main().catch(err => {
  logger.error('btc5m:fatal', { error: err.message });
  process.exit(1);
});
