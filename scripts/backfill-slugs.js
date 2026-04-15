// Backfills `slug` and `title` for positions, trades, btc5m_positions and btc5m_trades.
// Two-step lookup:
//   1. CLOB API  → market_slug + question/title  (by condition ID)
//   2. Gamma API → event slug   (market.events[0].slug)
// Usage: node scripts/backfill-slugs.js

import fetch from 'node-fetch';
import { getDb, all, run } from '../src/utils/db.js';

const CLOB_BASE  = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const DATA_API   = 'https://data-api.polymarket.com';

// Cache to avoid fetching the same conditionId twice in one run
const cache = new Map();

async function fetchMarketMeta(conditionId) {
  if (cache.has(conditionId)) return cache.get(conditionId);

  // Step 1: get market_slug and question from CLOB
  const clobRes = await fetch(`${CLOB_BASE}/markets/${conditionId}`, {
    headers: { Accept: 'application/json' },
  });
  if (!clobRes.ok) throw new Error(`CLOB ${clobRes.status}`);
  const clobData = await clobRes.json();
  const marketSlug = clobData.market_slug;
  if (!marketSlug) { cache.set(conditionId, null); return null; }

  const title = clobData.question ?? null;

  // Step 2: get event slug from Gamma using the market slug
  const gammaRes = await fetch(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(marketSlug)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!gammaRes.ok) throw new Error(`Gamma ${gammaRes.status}`);
  const gammaData = await gammaRes.json();
  const market    = (Array.isArray(gammaData) ? gammaData : (gammaData?.data ?? []))[0];
  const slug      = market?.events?.[0]?.slug ?? marketSlug;

  // marketSlug is the individual sub-market slug; slug is the parent event slug.
  // When they differ the market is part of a multi-option event (multiple teams/assets/dates).
  const meta = { slug, marketSlug, title };
  cache.set(conditionId, meta);
  return meta;
}

async function backfillTable(db, table, idCol = 'id') {
  // Check which columns exist in this table
  const cols = all(db, `PRAGMA table_info(${table})`).map(c => c.name);
  const hasSlug       = cols.includes('slug');
  const hasTitle      = cols.includes('title');
  const hasMarketSlug = cols.includes('market_slug');

  const selectCols = [
    idCol, 'market_id',
    hasSlug       ? 'slug'        : 'NULL as slug',
    hasTitle      ? 'title'       : 'NULL as title',
    hasMarketSlug ? 'market_slug' : 'NULL as market_slug',
  ].join(', ');
  const rows = all(db, `SELECT ${selectCols} FROM ${table}`);
  if (rows.length === 0) { console.log(`  ${table}: no rows`); return; }
  console.log(`  ${table}: ${rows.length} rows…`);

  for (const row of rows) {
    try {
      const meta = await fetchMarketMeta(row.market_id);
      if (!meta) { console.warn(`    ✗ ${row.market_id.slice(0, 14)}… — no meta returned`); continue; }

      const slugChanged       = hasSlug       && meta.slug       && meta.slug       !== row.slug;
      const titleChanged      = hasTitle      && meta.title      && meta.title      !== row.title;
      const marketSlugChanged = hasMarketSlug && meta.marketSlug && meta.marketSlug !== row.market_slug;

      if (!slugChanged && !titleChanged && !marketSlugChanged) {
        console.log(`    = ${row.market_id.slice(0, 14)}… already up to date`);
        continue;
      }

      const setParts = [];
      const params   = [];
      if (slugChanged)       { setParts.push('slug = ?');        params.push(meta.slug); }
      if (titleChanged)      { setParts.push('title = ?');       params.push(meta.title); }
      if (marketSlugChanged) { setParts.push('market_slug = ?'); params.push(meta.marketSlug); }
      params.push(row[idCol]);

      run(db, `UPDATE ${table} SET ${setParts.join(', ')} WHERE ${idCol} = ?`, params);
      console.log(`    ✓ ${row.market_id.slice(0, 14)}… slug=${meta.slug} market_slug=${meta.marketSlug} title=${meta.title?.slice(0, 40)}`);
    } catch (err) {
      console.error(`    ✗ ${row.market_id.slice(0, 14)}… — ${err.message}`);
    }
  }
}

async function backfillWalletNames(db) {
  const wallets = all(db, `SELECT address, name FROM wallets WHERE active = 1`);
  if (wallets.length === 0) { console.log('  wallets: no rows'); return; }
  console.log(`  wallets: ${wallets.length} rows…`);

  for (const w of wallets) {
    try {
      const res = await fetch(`${DATA_API}/activity?user=${w.address}&limit=1`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Data API ${res.status}`);
      const data = await res.json();
      const name = data?.[0]?.name ?? null;
      if (name && name !== w.name) {
        run(db, `UPDATE wallets SET name = ? WHERE address = ?`, [name, w.address]);
        console.log(`    ✓ ${w.address.slice(0, 14)}… → ${name}`);
      } else if (name === w.name) {
        console.log(`    = ${w.address.slice(0, 14)}… already correct (${name})`);
      } else {
        console.warn(`    ✗ ${w.address.slice(0, 14)}… — no name returned`);
      }
    } catch (err) {
      console.error(`    ✗ ${w.address.slice(0, 14)}… — ${err.message}`);
    }
  }
}

async function main() {
  const db = await getDb();

  console.log('Backfilling slugs and titles…');
  await backfillTable(db, 'positions');
  await backfillTable(db, 'trades');
  await backfillTable(db, 'btc5m_positions', 'rowid');
  await backfillTable(db, 'btc5m_trades');
  console.log('Backfilling wallet names…');
  await backfillWalletNames(db);
  console.log('Done.');
}

main().catch(err => {
  console.error('fatal:', err.message);
  process.exit(1);
});