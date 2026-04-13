// Backfills `slug` for positions, btc5m_positions and btc5m_trades.
// Two-step lookup:
//   1. CLOB API  → market_slug  (by condition ID)
//   2. Gamma API → event slug   (market.events[0].slug)
// Usage: node scripts/backfill-slugs.js

import fetch from 'node-fetch';
import { getDb, all, run } from '../src/utils/db.js';

const CLOB_BASE  = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// Cache to avoid fetching the same conditionId twice in one run
const cache = new Map();

async function fetchEventSlug(conditionId) {
  if (cache.has(conditionId)) return cache.get(conditionId);

  // Step 1: get market_slug from CLOB
  const clobRes = await fetch(`${CLOB_BASE}/markets/${conditionId}`, {
    headers: { Accept: 'application/json' },
  });
  if (!clobRes.ok) throw new Error(`CLOB ${clobRes.status}`);
  const clobData = await clobRes.json();
  const marketSlug = clobData.market_slug;
  if (!marketSlug) { cache.set(conditionId, null); return null; }

  // Step 2: get event slug from Gamma using the market slug
  const gammaRes = await fetch(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(marketSlug)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!gammaRes.ok) throw new Error(`Gamma ${gammaRes.status}`);
  const gammaData = await gammaRes.json();
  const market    = (Array.isArray(gammaData) ? gammaData : (gammaData?.data ?? []))[0];
  const slug      = market?.events?.[0]?.slug ?? marketSlug;
  cache.set(conditionId, slug);
  return slug;
}

async function backfillTable(db, table, idCol = 'id') {
  const rows = all(db, `SELECT ${idCol}, market_id, slug FROM ${table}`);
  if (rows.length === 0) { console.log(`  ${table}: no rows`); return; }
  console.log(`  ${table}: ${rows.length} rows…`);

  for (const row of rows) {
    try {
      const slug = await fetchEventSlug(row.market_id);
      if (slug && slug !== row.slug) {
        run(db, `UPDATE ${table} SET slug = ? WHERE ${idCol} = ?`, [slug, row[idCol]]);
        console.log(`    ✓ ${row.market_id.slice(0, 14)}… → ${slug}`);
      } else if (slug === row.slug) {
        console.log(`    = ${row.market_id.slice(0, 14)}… already correct`);
      } else {
        console.warn(`    ✗ ${row.market_id.slice(0, 14)}… — no slug returned`);
      }
    } catch (err) {
      console.error(`    ✗ ${row.market_id.slice(0, 14)}… — ${err.message}`);
    }
  }
}

async function main() {
  const db = await getDb();

  console.log('Backfilling slugs…');
  await backfillTable(db, 'positions');
  await backfillTable(db, 'btc5m_positions', 'rowid');
  await backfillTable(db, 'btc5m_trades');
  console.log('Done.');
}

main().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});
