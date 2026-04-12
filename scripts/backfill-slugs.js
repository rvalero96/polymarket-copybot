// One-off script: backfills `slug` for ALL positions using the correct event slug.
// Two-step lookup:
//   1. CLOB API  → market_slug  (by condition ID)
//   2. Gamma API → event slug   (market.events[0].slug)
// Usage: node scripts/backfill-slugs.js

import fetch from 'node-fetch';
import { getDb, all, run } from '../src/utils/db.js';

const CLOB_BASE  = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

async function fetchEventSlug(conditionId) {
  // Step 1: get market_slug from CLOB
  const clobRes = await fetch(`${CLOB_BASE}/markets/${conditionId}`, {
    headers: { Accept: 'application/json' },
  });
  if (!clobRes.ok) throw new Error(`CLOB ${clobRes.status}`);
  const clobData = await clobRes.json();
  const marketSlug = clobData.market_slug;
  if (!marketSlug) return null;

  // Step 2: get event slug from Gamma using the market slug
  const gammaRes = await fetch(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(marketSlug)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!gammaRes.ok) throw new Error(`Gamma ${gammaRes.status}`);
  const gammaData = await gammaRes.json();
  const market    = (Array.isArray(gammaData) ? gammaData : (gammaData?.data ?? []))[0];
  return market?.events?.[0]?.slug ?? marketSlug; // fallback to market slug if no event
}

async function main() {
  const db   = await getDb();
  // Re-run over ALL positions so existing wrong slugs also get corrected
  const rows = all(db, `SELECT id, market_id, slug FROM positions`);

  if (rows.length === 0) {
    console.log('No positions found.');
    return;
  }

  console.log(`Fetching event slugs for ${rows.length} positions…`);

  for (const row of rows) {
    try {
      const slug = await fetchEventSlug(row.market_id);
      if (slug && slug !== row.slug) {
        run(db, `UPDATE positions SET slug = ? WHERE id = ?`, [slug, row.id]);
        console.log(`  ✓ ${row.market_id.slice(0, 14)}… → ${slug}`);
      } else if (slug === row.slug) {
        console.log(`  = ${row.market_id.slice(0, 14)}… already correct (${slug})`);
      } else {
        console.warn(`  ✗ ${row.market_id.slice(0, 14)}… — no slug returned`);
      }
    } catch (err) {
      console.error(`  ✗ ${row.market_id.slice(0, 14)}… — ${err.message}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});
