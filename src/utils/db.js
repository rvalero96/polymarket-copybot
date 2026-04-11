import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { CONFIG } from '../../config.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let _db = null;

function initSqlite() {
  return new Promise((resolve) => {
    const sqlite = require('node-sqlite3-wasm');
    if (sqlite.calledRun) {
      resolve(sqlite);
    } else {
      sqlite.onRuntimeInitialized = () => resolve(sqlite);
    }
  });
}

export async function getDb() {
  if (_db) return _db;

  const sqlite = await initSqlite();
  const { Database } = sqlite;

  const dir = dirname(CONFIG.DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(
    existsSync(CONFIG.DB_PATH) ? readFileSync(CONFIG.DB_PATH) : undefined
  );

  db.persist = () => writeFileSync(CONFIG.DB_PATH, db.export());

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
      status        TEXT NOT NULL DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id     TEXT NOT NULL,
      outcome       TEXT NOT NULL,
      wallet        TEXT NOT NULL,
      avg_price     REAL NOT NULL,
      size_usdc     REAL NOT NULL,
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
  `);

  db.persist();
  _db = db;
  return db;
}

export function all(db, sql, params = []) {
  return db.all(sql, params);
}

export function run(db, sql, params = []) {
  return db.run(sql, params);
}
