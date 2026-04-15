// Arbitrage scanner — detects price inconsistencies across logically related markets
// Strategies implemented:
//   monotonicity  — higher threshold must have ≤ probability than lower threshold
//   basket        — sum of all outcomes in a categorical market must equal ~1.0
//   spread        — YES + NO on a binary market should not compress below threshold

import { getActiveMarkets, getMidpointPrice } from '../services/polymarket/api.js';
import { getDb, all, run } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../../config.js';

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

  // Only keep markets with sufficient liquidity and valid token info
  return markets.filter(m =>
    m.active &&
    !m.closed &&
    Array.isArray(m.tokens) && m.tokens.length >= 2 &&
    (parseFloat(m.liquidity ?? 0) >= ARB.MIN_LEG_LIQUIDITY)
  );
}

// ── Price fetching ────────────────────────────────────────────────────────────

async function fetchPrices(market) {
  const prices = {};
  for (const token of market.tokens) {
    try {
      prices[token.outcome] = await getMidpointPrice(token.token_id);
    } catch (_) {
      prices[token.outcome] = null;
    }
  }
  return prices;
}

// ── Grouping helpers ──────────────────────────────────────────────────────────

// Extract a numeric threshold from a market question, e.g.:
//   "Will BTC close above $82,000?"  →  82000
//   "Will ETH be above 3,500 USDC?"  →  3500
//   "Will SOL reach $200?"            →  200
function extractThreshold(question) {
  if (!question) return null;
  const m = question.match(/\$?([\d,]+(?:\.\d+)?)\s*[kKmMbB]?\b/g);
  if (!m) return null;
  for (const raw of m) {
    const clean = raw.replace(/[$,]/g, '').trim().toLowerCase();
    const mult  = clean.endsWith('k') ? 1e3 : clean.endsWith('m') ? 1e6 : clean.endsWith('b') ? 1e9 : 1;
    const val   = parseFloat(clean) * mult;
    if (val >= 100) return val; // ignore tiny numbers like years-in-slug
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

// Derive a stable group key from the slug by stripping trailing timestamps/thresholds
function slugPrefix(slug) {
  if (!slug) return null;
  return slug
    .replace(/-\d{10,}$/, '')   // Unix timestamp suffix
    .replace(/-[\d]+$/, '')     // generic trailing number
    .toLowerCase();
}

// ── Strategy: monotonicity ─────────────────────────────────────────────────────
// For a list of related binary markets sorted by ascending threshold:
//   P(YES | threshold_low) ≥ P(YES | threshold_high)
// A violation (price_high > price_low) creates a guaranteed profit by buying:
//   YES on lower threshold  +  NO on higher threshold
// Min profit = price(YES_high) - price(YES_low) - round_trip_cost

function detectMonotonicity(group) {
  if (group.length < 2) return [];

  // Sort ascending by threshold
  const sorted = [...group].sort((a, b) => a.threshold - b.threshold);
  const opportunities = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const low  = sorted[i]; // smaller threshold → should have HIGHER YES price
      const high = sorted[j]; // larger  threshold → should have LOWER  YES price

      const yesLow  = low.prices['Yes']  ?? low.prices['UP']  ?? null;
      const yesHigh = high.prices['Yes'] ?? high.prices['UP'] ?? null;
      if (yesLow === null || yesHigh === null) continue;

      const violation = yesHigh - yesLow; // positive = mispricing
      if (violation <= 0) continue;

      // Guaranteed arb: buy YES_low + buy NO_high
      // Cost  = yesLow + (1 - yesHigh)
      // Return = 1 in all scenarios (proof in plan doc)
      const cost           = yesLow + (1 - yesHigh);
      const grossProfit    = 1 - cost;                       // always positive when violation > 0
      const expectedProfit = grossProfit - ROUND_TRIP_COST;
      if (expectedProfit <= 0) continue;

      const confidence = Math.min(
        1,
        (violation / 0.15) * 0.5 +                          // size of violation
        (Math.min(low.liquidity, high.liquidity) / 5000) * 0.3 + // liquidity weight
        (violation > 0.05 ? 0.2 : 0)                        // bonus for large gaps
      );

      opportunities.push({
        strategy: 'monotonicity',
        description: `YES@${low.threshold} (${(yesLow * 100).toFixed(1)}%) + NO@${high.threshold} (${((1 - yesHigh) * 100).toFixed(1)}%) — violation +${(violation * 100).toFixed(1)}%`,
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
  if (!market.tokens || market.tokens.length < 3) return null;
  const prices = market.prices;

  const validPrices = market.tokens
    .map(t => prices[t.outcome])
    .filter(p => p !== null && p > 0);

  if (validPrices.length !== market.tokens.length) return null;

  const sum = validPrices.reduce((a, b) => a + b, 0);

  if (sum < ARB.BASKET_UNDERPRICED_THRESHOLD) {
    const grossProfit    = 1 - sum;
    const legs           = market.tokens.map(t => ({
      market_id: market.conditionId, outcome: t.outcome, side: 'buy', price: prices[t.outcome],
    }));
    const totalFees      = ROUND_TRIP_COST * legs.length;
    const expectedProfit = grossProfit - totalFees;
    if (expectedProfit <= 0) return null;

    const confidence = Math.min(1, (grossProfit / 0.10) * 0.6 + (market.liquidity / 10000) * 0.4);

    return {
      strategy:        'basket',
      description:     `Multi-outcome sum=${sum.toFixed(3)} (${market.question?.slice(0, 60) ?? market.conditionId})`,
      expected_profit: expectedProfit,
      confidence,
      legs,
      market_ids: [market.conditionId],
    };
  }

  return null;
}

// ── Strategy: spread anomaly ──────────────────────────────────────────────────
// Binary YES + NO should sum to ≈ 1.0 (the platform charges the spread above 1.0)
// If sum < SPREAD_ANOMALY_THRESHOLD it may indicate stale/mispriced quotes

function detectSpread(market) {
  if (!market.tokens || market.tokens.length !== 2) return null;
  const prices = market.prices;

  const yesPrice = prices['Yes'] ?? null;
  const noPrice  = prices['No']  ?? null;
  if (yesPrice === null || noPrice === null) return null;
  if (yesPrice <= 0 || noPrice <= 0) return null;

  const sum = yesPrice + noPrice;
  if (sum >= ARB.SPREAD_ANOMALY_THRESHOLD) return null;

  // Buy both: pay sum, guaranteed return 1.0
  const grossProfit    = 1 - sum;
  const expectedProfit = grossProfit - ROUND_TRIP_COST * 2;
  if (expectedProfit <= 0) return null;

  const confidence = Math.min(1, (grossProfit / 0.05) * 0.7 + (market.liquidity / 5000) * 0.3);

  return {
    strategy:        'spread',
    description:     `YES(${(yesPrice * 100).toFixed(1)}%) + NO(${(noPrice * 100).toFixed(1)}%) = ${(sum * 100).toFixed(1)}% — sum anomaly`,
    expected_profit: expectedProfit,
    confidence,
    legs: [
      { market_id: market.conditionId, outcome: 'Yes', side: 'buy', price: yesPrice },
      { market_id: market.conditionId, outcome: 'No',  side: 'buy', price: noPrice  },
    ],
    market_ids: [market.conditionId],
  };
}

// ── Persist results ───────────────────────────────────────────────────────────

function saveOpportunity(db, opp) {
  const now     = Date.now();
  const groupKey = opp.market_ids.sort().join('|');

  // Upsert group
  run(db,
    `INSERT INTO arb_groups (group_key, strategy, market_ids, detected_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_key, strategy) DO UPDATE SET
       market_ids  = excluded.market_ids,
       detected_at = excluded.detected_at,
       resolved_at = NULL`,
    [groupKey, opp.strategy, JSON.stringify(opp.market_ids), now]
  );
  const group = all(db, `SELECT id FROM arb_groups WHERE group_key = ? AND strategy = ?`, [groupKey, opp.strategy])[0];

  // Insert new opportunity (one per scan run for this group)
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
  run(db, `UPDATE arb_opportunities SET status = 'expired'
           WHERE status = 'open' AND detected_at < ?`, [Date.now() - 2 * 3600 * 1000]);

  const markets = await fetchMarkets();
  logger.info('arb:scan:markets', { count: markets.length });

  if (!markets.length) {
    logger.info('arb:scan:done', { opportunities: 0 });
    return [];
  }

  // Fetch prices for every market (parallel batches of 10)
  const enriched = [];
  for (let i = 0; i < markets.length; i += 10) {
    const batch = markets.slice(i, i + 10);
    await Promise.all(batch.map(async m => {
      m.prices    = await fetchPrices(m);
      m.liquidity = parseFloat(m.liquidity ?? 0);
      enriched.push(m);
    }));
  }

  // ── Group markets by question template for monotonicity ──────────────────
  const templateGroups = new Map();
  for (const m of enriched) {
    m.threshold = extractThreshold(m.question);
    if (m.threshold === null) continue;
    const tmpl = questionTemplate(m.question);
    if (!tmpl) continue;
    if (!templateGroups.has(tmpl)) templateGroups.set(tmpl, []);
    templateGroups.get(tmpl).push(m);
  }

  const opportunities = [];

  // Run monotonicity strategy on each group
  for (const [tmpl, group] of templateGroups) {
    if (group.length < 2) continue;
    const opps = detectMonotonicity(group);
    for (const opp of opps) {
      logger.info('arb:scan:opportunity', { strategy: opp.strategy, profit: opp.expected_profit, description: opp.description });
      saveOpportunity(db, opp);
      opportunities.push(opp);
    }
  }

  // Run basket + spread strategies on individual markets
  for (const m of enriched) {
    const basket = detectBasket(m);
    if (basket) {
      logger.info('arb:scan:opportunity', { strategy: basket.strategy, profit: basket.expected_profit });
      saveOpportunity(db, basket);
      opportunities.push(basket);
    }

    const spread = detectSpread(m);
    if (spread) {
      logger.info('arb:scan:opportunity', { strategy: spread.strategy, profit: spread.expected_profit });
      saveOpportunity(db, spread);
      opportunities.push(spread);
    }
  }

  logger.info('arb:scan:done', { opportunities: opportunities.length });
  return opportunities;
}
