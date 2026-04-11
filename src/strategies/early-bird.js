// early-bird-5m — signal logic for 5-min binary markets
// Indicators: Wilder RSI(14) on 1m candles + ATR(14) + price divergence

export function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? -changes[i] : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function computeATR(candles, period = 14) {
  if (candles.length < 2) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Returns { outcome: 'UP' | 'DOWN' } or null
// - spotPrice: current Binance spot price
// - priceToBeat: the market's resolution threshold
// - rsi: Wilder RSI value
// - atr: Average True Range
// - upPrice / downPrice: current CLOB prices for each outcome (0-1)
export function generateSignal({ spotPrice, priceToBeat, rsi, atr, upPrice, downPrice }) {
  if (rsi === null) return null;

  // Skip if market is flat (< 0.005% ATR) or too chaotic (> 0.5% ATR)
  if (atr !== null) {
    const atrPct = (atr / spotPrice) * 100;
    if (atrPct < 0.005 || atrPct > 0.5) return null;
  }

  // "Up or Down" markets: no price threshold, use pure RSI + outcome pricing
  if (priceToBeat === null) {
    if (rsi >= 58 && upPrice !== null && upPrice < 0.52) return { outcome: 'UP' };
    if (rsi <= 42 && downPrice !== null && downPrice < 0.52) return { outcome: 'DOWN' };
    return null;
  }

  // Markets with explicit threshold (e.g. "Will BTC be above $82,000?")
  const divergence = (spotPrice - priceToBeat) / priceToBeat;

  // BUY UP: momentum bullish + spot trending above threshold + UP side is cheap
  if (rsi >= 58 && divergence > 0.0005 && upPrice !== null && upPrice < 0.52) {
    return { outcome: 'UP' };
  }

  // BUY DOWN: momentum bearish + spot trending below threshold + DOWN side is cheap
  if (rsi <= 42 && divergence < -0.0005 && downPrice !== null && downPrice < 0.52) {
    return { outcome: 'DOWN' };
  }

  return null;
}
