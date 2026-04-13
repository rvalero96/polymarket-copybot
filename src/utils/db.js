import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CONFIG } from '../../config.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let _db = null;

export async function getDb() {
  if (_db) return _db;

  const Database = require('better-sqlite3');

  const dir = dirname(CONFIG.DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(CONFIG.DB_PATH);
  db.persist = () => {};  // better-sqlite3 escribe directo al disco

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS wallets (
      address     TEXT PRIMARY KEY,
      added_at    INTEGER NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      win_rate    REAL,
      roi         REAL,
      pnl_total   REAL DEFAULT 0,
      score       REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS signals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet        TEXT NOT NULL,
      market_id     TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      action        TEXT NOT NULL,
      price         REAL NOT NULL,
      size          REAL NOT NULL,
      detected_at   INTEGER NOT NULL,
      processed     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id     INTEGER REFERENCES signals(id),
      market_id     TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      side          TEXT NOT NULL,
      size_usdc     REAL NOT NULL,
      price         REAL NOT NULL,
      fee           REAL NOT NULL,
      slippage      REAL NOT NULL,
      executed_at   INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      pnl           REAL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id     TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      wallet        TEXT NOT NULL,
      avg_price     REAL NOT NULL,
      size_usdc     REAL NOT NULL,
      slug          TEXT,
      opened_at     INTEGER NOT NULL,
      UNIQUE(market_id, outcome, wallet)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      date          TEXT PRIMARY KEY,
      bankroll      REAL NOT NULL,
      pnl_day       REAL NOT NULL,
      pnl_total     REAL NOT NULL,
      open_positions INTEGER NOT NULL,
      win_rate      REAL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS btc5m_positions (
      market_id    TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      asset        TEXT NOT NULL DEFAULT 'BTC',
      size_usdc    REAL NOT NULL,
      entry_price  REAL NOT NULL,
      token_id     TEXT,
      opened_at    INTEGER NOT NULL,
      PRIMARY KEY (market_id, outcome)
    );

    CREATE TABLE IF NOT EXISTS btc5m_trades (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id    TEXT NOT NULL,
      asset        TEXT NOT NULL DEFAULT 'BTC',
      outcome      TEXT NOT NULL,
      side         TEXT NOT NULL,
      size_usdc    REAL NOT NULL,
      entry_price  REAL NOT NULL,
      exit_price   REAL,
      fee          REAL NOT NULL DEFAULT 0,
      slippage     REAL NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'open',
      pnl          REAL,
      opened_at    INTEGER NOT NULL,
      closed_at    INTEGER
    );
  `);

  // Migrate existing DBs that predate new columns
  try { db.exec('ALTER TABLE positions ADD COLUMN slug TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE trades ADD COLUMN pnl REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE btc5m_positions ADD COLUMN slug TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE btc5m_trades ADD COLUMN slug TEXT'); } catch (_) {}

  _db = db;
  return db;
}

export function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}
