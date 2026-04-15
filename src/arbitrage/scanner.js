// Arbitrage scanner — detects price inconsistencies across logically related markets
// Strategies:
//   monotonicity  — higher threshold must have ≤ probability than lower threshold
//   basket        — sum of all outcomes in a categorical market must equal ~1.0
//   spread        — YES + NO on a binary market should not compress below threshold

import { getActiveMarkets } from '../services/polymarket/api.js';
import { getDb, all, run }  from '../utils/db.js';
import { logger }           from '../utils/logger.js';
import { CONFIG }           from '../../config.js';

const { FEE_PCT, SLIPPAGE_PCT, ARB } = CONFIG;
const ROUND_TRIP_COST = (FEE_PCT + SLIPPAGE_PCT) * 2; // two legs

// ── Market fetching ───────────────────────────────────────────────────────────

async function fetchMarkets() {
  const markets = [];
  const pageSize = 100;
  let offset = 0;

  while (markets.length < ARB.SCAN_LIMIT) {
    const batch = await getActiveMarkets({ limit: pageSize, offset });
    const list  = Array.isArray(batch) ? batch : (batch?.data ?? []);
    if (!list.length) break;
    markets.push(...list);
    if (list.length < pageSize) break;
    offset += pageSize;
  }

  // Only keep markets with price data and sufficient liquidity
  // The Gamma API bulk response uses outcomePrices / clobTokenIds (JSON strings),
  // NOT a `tokens` array — that field only exists on individual market fetches.
  return markets.filter(m =>
    m.active &&
    !m.closed &&
    (m.outcomePrices || m.clobTokenIds) &&
    parseFloat(m.liquidity ?? 0) >= ARB.MIN_LEG_LIQUIDITY
  );
}

// ── Price extraction ──────────────────────────────────────────────────────────
// The Gamma API bulk response encodes prices as a JSON string array in outcomePrices
// and outcome names as a JSON string array in outcomes.
// e.g. outcomePrices = '["0.72","0.28"]', outcomes = '["Yes","No"]'

function extractPrices(market) {
  const rawOutcomes = market.outcomes      ?? '["Yes","No"]';
  const rawPrices   = market.outcomePrices ?? '[]';

  const outcomes = typeof rawOutcomes === 'string' ? JSON.parse(rawOutcomes) : rawOutcomes;
  const prices   = typeof rawPrices   === 'string' ? JSON.parse(rawPrices)   : rawPrices;

  const result = {};
  outcomes.forEach((outcome, i) => {
    const p = prices[i] != null ? parseFloat(prices[i]) : null;
    result[outcome] = (p !== null && !isNaN(p) && p > 0) ? p : null;
  });
  return result;
}

// ── Grouping helpers ──────────────────────────────────────────────────────────

// Extract a numeric threshold from a market question, e.g.:
//   "Will BTC close above $82,000?"  →  82000
//   "Will ETH be above 3,500 USDC?"  →  3500
function extractThreshold(question) {
  if (!question) return null;
  const matches = question.match(/\$?([\d,]+(?:\.\d+)?)\s*[kKmMbB]?\b/g);
  if (!matches) return null;
  for (const raw of matches) {
    const clean = raw.replace(/[$,]/g, '').trim().toLowerCase();
    const mult  = clean.endsWith('k') ? 1e3 : clean.endsWith('m') ? 1e6 : clean.endsWith('b') ? 1e9 : 1;
    const val   = parseFloat(clean) * mult;
    if (val >= 100) return val; // ignore tiny numbers like days-of-month
  }
  return null;
}

// Normalise a question to a "template" by replacing the threshold number with a placeholder.
// Two questions with the same template are part of the same monotonicity group.
function questionTemplate(question) {
  if (!question) return '';
  return question
    .replace(/\$[\d,]+(?:\.\d+)?(?:\s*[kKmMbB])?/g, '$?') // "$82,000" → "$?"
    .replace(/\b[\d,]{4,}(?:\.\d+)?\b/g, '?')              // bare large numbers
    .toLowerCase()
    .replace(/[^a-z0-9?]+/g, ' ')
    .trim();
}

// ── Strategy: monotonicity ─────────────────────────────────────────────────────
// For a list of related binary markets sorted by ascending threshold:
//   P(YES | threshold_low) ≥ P(YES | threshold_high)
//
// A violation (price_high > price_low) creates a guaranteed arbitrage:
//   Buy YES_low  +  Buy NO_high
//   Cost  = price(YES_low) + (1 − price(YES_high))  < 1.0  (always when violation > 0)
//   Return = 1.0 in ALL three scenarios (BTC > high, between, or < low)
//   Profit = 1 − cost − round_trip_fees

function detectMonotonicity(group) {
  if (group.length < 2) return [];

  const sorted       = [...group].sort((a, b) => a.threshold - b.threshold);
  const opportunities = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const low  = sorted[i]; // smaller threshold → should have HIGHER YES price
      const high = sorted[j]; // larger  threshold → should have LOWER  YES price

      const yesLow  = low.prices['Yes']  ?? low.prices['YES']  ?? null;
      const yesHigh = high.prices['Yes'] ?? high.prices['YES'] ?? null;
      if (yesLow === null || yesHigh === null) continue;
      if (yesLow <= 0 || yesHigh <= 0) continue;

      const violation = yesHigh - yesLow; // positive = mispricing
      if (violation <= 0) continue;

      const cost           = yesLow + (1 - yesHigh);
      const grossProfit    = 1 - cost;
      const expectedProfit = grossProfit - ROUND_TRIP_COST;
      if (expectedProfit <= 0) continue;

      const confidence = Math.min(1,
        (violation / 0.15) * 0.5 +
        (Math.min(low.liquidity, high.liquidity) / 5000) * 0.3 +
        (violation > 0.05 ? 0.2 : 0)
      );

      opportunities.push({
        strategy:        'monotonicity',
        description:     `YES@${low.threshold} (${(yesLow * 100).toFixed(1)}%) + NO@${high.threshold} (${((1 - yesHigh) * 100).toFixed(1)}%) — violación +${(violation * 100).toFixed(1)}%`,
        expected_profit: expectedProfit,
        confidence,
        legs: [
          { market_id: low.conditionId,  outcome: 'Yes', side: 'buy', price: yesLow,       threshold: low.threshold  },
          { market_id: high.conditionId, outcome: 'No',  side: 'buy', price: 1 - yesHigh,  threshold: high.threshold },
        ],
        market_ids: [low.conditionId, high.conditionId],
      });
    }
  }

  return opportunities;
}

// ── Strategy: basket ──────────────────────────────────────────────────────────
// For multi-outcome markets the sum of all outcome prices should ≈ 1.0
// If sum < BASKET_UNDERPRICED_THRESHOLD: buy all outcomes for guaranteed profit

function detectBasket(market) {
  const outcomes = Object.keys(market.prices);
  if (outcomes.length < 3) return null;

  const validPrices = outcomes.map(o => market.prices[o]).filter(p => p !== null && p > 0);
  if (validPrices.length !== outcomes.length) return null;

  const sum = validPrices.reduce((a, b) => a + b, 0);
  if (sum >= ARB.BASKET_UNDERPRICED_THRESHOLD) return null;

  const grossProfit    = 1 - sum;
  const legs           = outcomes.map(o => ({
    market_id: market.conditionId, outcome: o, side: 'buy', price: market.prices[o],
  }));
  const expectedProfit = grossProfit - ROUND_TRIP_COST * legs.length;
  if (expectedProfit <= 0) return null;

  const confidence = Math.min(1, (grossProfit / 0.10) * 0.6 + (market.liquidity / 10000) * 0.4);

  return {
    strategy:        'basket',
    description:     `Multi-resultado suma=${sum.toFixed(3)} — ${(market.question ?? '').slice(0, 60)}`,
    expected_profit: expectedProfit,
    confidence,
    legs,
    market_ids: [market.conditionId],
  };
}

// ── Strategy: spread anomaly ──────────────────────────────────────────────────
// Binary YES + NO should sum to ≈ 1.0; if sum drops below threshold it means
// both sides are cheap — buy both for a guaranteed return of 1.0

function detectSpread(market) {
  const outcomes = Object.keys(market.prices);
  if (outcomes.length !== 2) return null;

  const [oA, oB]  = outcomes;
  const pA        = market.prices[oA];
  const pB        = market.prices[oB];
  if (pA === null || pB === null || pA <= 0 || pB <= 0) return null;

  const sum = pA + pB;
  if (sum >= ARB.SPREAD_ANOMALY_THRESHOLD) return null;

  const grossProfit    = 1 - sum;
  const expectedProfit = grossProfit - ROUND_TRIP_COST * 2;
  if (expectedProfit <= 0) return null;

  const confidence = Math.min(1, (grossProfit / 0.05) * 0.7 + (market.liquidity / 5000) * 0.3);

  return {
    strategy:        'spread',
    description:     `${oA}(${(pA * 100).toFixed(1)}%) + ${oB}(${(pB * 100).toFixed(1)}%) = ${(sum * 100).toFixed(1)}% — suma anómala`,
    expected_profit: expectedProfit,
    confidence,
    legs: [
      { market_id: market.conditionId, outcome: oA, side: 'buy', price: pA },
      { market_id: market.conditionId, outcome: oB, side: 'buy', price: pB },
    ],
    market_ids: [market.conditionId],
  };
}

// ── Persist results ───────────────────────────────────────────────────────────

function saveOpportunity(db, opp) {
  const now      = Date.now();
  const groupKey = opp.market_ids.sort().join('|');

  run(db,
    `INSERT INTO arb_groups (group_key, strategy, market_ids, detected_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_key, strategy) DO UPDATE SET
       market_ids  = excluded.market_ids,
       detected_at = excluded.detected_at,
       resolved_at = NULL`,
    [groupKey, opp.strategy, JSON.stringify(opp.market_ids), now]
  );

  const group = all(db,
    `SELECT id FROM arb_groups WHERE group_key = ? AND strategy = ?`,
    [groupKey, opp.strategy]
  )[0];

  run(db,
    `INSERT INTO arb_opportunities
       (group_id, strategy, description, expected_profit, confidence, legs, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [group.id, opp.strategy, opp.description, opp.expected_profit, opp.confidence,
     JSON.stringify(opp.legs), now]
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function scan() {
  logger.info('arb:scan:start');
  const db = await getDb();

  // Expire open opportunities older than 2 hours
  run(db,
    `UPDATE arb_opportunities SET status = 'expired'
     WHERE status = 'open' AND detected_at < ?`,
    [Date.now() - 2 * 3600 * 1000]
  );

  const markets = await fetchMarkets();
  logger.info('arb:scan:markets', { count: markets.length });

  if (!markets.length) {
    logger.info('arb:scan:done', { opportunities: 0 });
    return [];
  }

  // Extract prices from the already-included outcomePrices field (no extra API calls)
  const enriched = markets.map(m => ({
    ...m,
    prices:    extractPrices(m),
    liquidity: parseFloat(m.liquidity ?? 0),
    threshold: extractThreshold(m.question),
  }));

  // ── Diagnostics ──────────────────────────────────────────────────────────
  const withThreshold  = enriched.filter(m => m.threshold !== null).length;
  const binaryMarkets  = enriched.filter(m => Object.keys(m.prices).length === 2);
  const pricedBinary   = binaryMarkets.filter(m => {
    const vals = Object.values(m.prices);
    return vals.every(v => v !== null && v > 0);
  });
  const priceSums      = pricedBinary.map(m => Object.values(m.prices).reduce((a, b) => a + b, 0));
  const minSum         = priceSums.length ? Math.min(...priceSums).toFixed(4) : 'n/a';
  const maxSum         = priceSums.length ? Math.max(...priceSums).toFixed(4) : 'n/a';
  const multiOutcome   = enriched.filter(m => Object.keys(m.prices).length >= 3).length;

  logger.info('arb:scan:enriched', {
    count: enriched.length,
    with_threshold: withThreshold,
    binary_priced: pricedBinary.length,
    multi_outcome: multiOutcome,
    binary_sum_min: minSum,
    binary_sum_max: maxSum,
  });

  // ── Group markets by question template for monotonicity ──────────────────
  const templateGroups = new Map();
  for (const m of enriched) {
    if (m.threshold === null) continue;
    const tmpl = questionTemplate(m.question);
    if (!tmpl) continue;
    if (!templateGroups.has(tmpl)) templateGroups.set(tmpl, []);
    templateGroups.get(tmpl).push(m);
  }

  // Log the groups that have 2+ markets (the ones that get checked for violations)
  const groupsChecked = [...templateGroups.values()].filter(g => g.length >= 2);
  logger.info('arb:scan:monotonicity_groups', {
    total_template_groups: templateGroups.size,
    groups_with_2plus: groupsChecked.length,
    // Show up to 5 sample groups with their thresholds and prices
    samples: groupsChecked.slice(0, 5).map(g =>
      g.map(m => ({ t: m.threshold, yes: Object.values(m.prices)[0]?.toFixed(3) }))
    ),
  });

  const opportunities = [];

  for (const [, group] of templateGroups) {
    if (group.length < 2) continue;
    const opps = detectMonotonicity(group);
    for (const opp of opps) {
      logger.info('arb:opportunity', { strategy: opp.strategy, profit: opp.expected_profit.toFixed(4), desc: opp.description });
      saveOpportunity(db, opp);
      opportunities.push(opp);
    }
  }

  for (const m of enriched) {
    const basket = detectBasket(m);
    if (basket) {
      logger.info('arb:opportunity', { strategy: basket.strategy, profit: basket.expected_profit.toFixed(4) });
      saveOpportunity(db, basket);
      opportunities.push(basket);
    }

    const spread = detectSpread(m);
    if (spread) {
      logger.info('arb:opportunity', { strategy: spread.strategy, profit: spread.expected_profit.toFixed(4) });
      saveOpportunity(db, spread);
      opportunities.push(spread);
    }
  }

  logger.info('arb:scan:done', { opportunities: opportunities.length });
  return opportunities;
}
