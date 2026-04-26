SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS wallets (
    address     TEXT PRIMARY KEY,
    added_at    INTEGER NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    win_rate    REAL,
    roi         REAL,
    pnl_total   REAL DEFAULT 0,
    score       REAL DEFAULT 0,
    name        TEXT
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
    pnl           REAL,
    title         TEXT,
    market_slug   TEXT,
    close_reason  TEXT
);

CREATE TABLE IF NOT EXISTS positions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id         TEXT NOT NULL,
    outcome           TEXT NOT NULL,
    wallet            TEXT NOT NULL,
    avg_price         REAL NOT NULL,
    size_usdc         REAL NOT NULL,
    slug              TEXT,
    title             TEXT,
    market_slug       TEXT,
    opened_at         INTEGER NOT NULL,
    market_end_date   TEXT,
    last_price        REAL,
    price_tracked_at  INTEGER,
    UNIQUE(market_id, outcome, wallet)
);

CREATE TABLE IF NOT EXISTS snapshots (
    date           TEXT PRIMARY KEY,
    bankroll       REAL NOT NULL,
    pnl_day        REAL NOT NULL,
    pnl_total      REAL NOT NULL,
    open_positions INTEGER NOT NULL,
    win_rate       REAL,
    created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS btc5m_positions (
    market_id    TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    asset        TEXT NOT NULL DEFAULT 'BTC',
    size_usdc    REAL NOT NULL,
    entry_price  REAL NOT NULL,
    token_id     TEXT,
    slug         TEXT,
    title        TEXT,
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
    slug         TEXT,
    title        TEXT,
    opened_at    INTEGER NOT NULL,
    closed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS kelly_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio      REAL    NOT NULL,
    phase          INTEGER NOT NULL,
    raw_kelly      REAL    NOT NULL,
    multiplier     REAL    NOT NULL,
    fraction       REAL    NOT NULL,
    trading_budget REAL    NOT NULL,
    aave_budget    REAL    NOT NULL,
    position_size  REAL    NOT NULL,
    win_rate       REAL,
    odds_b         REAL,
    total_trades   INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aave_yields (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    amount     REAL    NOT NULL,
    apy        REAL    NOT NULL,
    idle_cash  REAL    NOT NULL,
    hours      REAL    NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS arb_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_key   TEXT NOT NULL,
    strategy    TEXT NOT NULL,
    market_ids  TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    resolved_at INTEGER,
    UNIQUE(group_key, strategy)
);

CREATE TABLE IF NOT EXISTS arb_opportunities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id        INTEGER REFERENCES arb_groups(id),
    strategy        TEXT NOT NULL,
    description     TEXT NOT NULL,
    expected_profit REAL NOT NULL,
    confidence      REAL NOT NULL,
    legs            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    detected_at     INTEGER NOT NULL,
    expires_at      INTEGER
);

CREATE TABLE IF NOT EXISTS arb_trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_id  INTEGER REFERENCES arb_opportunities(id),
    leg_index       INTEGER NOT NULL,
    market_id       TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    side            TEXT NOT NULL,
    price           REAL NOT NULL,
    size_usdc       REAL NOT NULL,
    fee             REAL NOT NULL DEFAULT 0,
    slippage        REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'open',
    pnl             REAL,
    title           TEXT,
    market_slug     TEXT,
    opened_at       INTEGER NOT NULL,
    closed_at       INTEGER
);

CREATE TABLE IF NOT EXISTS grid_config (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    grid_min        REAL    NOT NULL,
    grid_max        REAL    NOT NULL,
    levels          INTEGER NOT NULL,
    order_size      REAL    NOT NULL,
    order_size_pct  REAL,
    status          TEXT    NOT NULL DEFAULT 'stopped',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grid_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id       INTEGER NOT NULL REFERENCES grid_config(id),
    level           INTEGER NOT NULL,
    buy_price       REAL    NOT NULL,
    sell_price      REAL    NOT NULL,
    order_size      REAL    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    buy_fill_price  REAL,
    sell_fill_price REAL,
    bought_at       INTEGER,
    sold_at         INTEGER
);

CREATE TABLE IF NOT EXISTS grid_trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL REFERENCES grid_orders(id),
    buy_price       REAL    NOT NULL,
    sell_price      REAL    NOT NULL,
    order_size_usd  REAL    NOT NULL,
    pnl             REAL    NOT NULL,
    fee             REAL    NOT NULL DEFAULT 0,
    opened_at       INTEGER NOT NULL,
    closed_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pepe_grid_config (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_size      REAL    NOT NULL,
    order_size_pct  REAL,
    ma_type         TEXT    NOT NULL DEFAULT 'EMA',
    ma_period       INTEGER NOT NULL DEFAULT 20,
    interval_pct    REAL    NOT NULL DEFAULT 0.02,
    laziness_pct    REAL    NOT NULL DEFAULT 0.015,
    candle_tf       TEXT    NOT NULL DEFAULT '1m',
    anchor_price    REAL,
    grid_interval   REAL,
    status          TEXT    NOT NULL DEFAULT 'stopped',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pepe_grid_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id       INTEGER NOT NULL REFERENCES pepe_grid_config(id),
    grid_epoch      INTEGER NOT NULL DEFAULT 0,
    level_index     INTEGER NOT NULL,
    buy_price       REAL    NOT NULL,
    sell_price      REAL    NOT NULL,
    order_size      REAL    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    buy_fill_price  REAL,
    sell_fill_price REAL,
    bought_at       INTEGER,
    sold_at         INTEGER,
    cooldown_until  INTEGER
);

CREATE TABLE IF NOT EXISTS pepe_grid_trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        INTEGER NOT NULL REFERENCES pepe_grid_orders(id),
    level_index     INTEGER NOT NULL,
    grid_epoch      INTEGER NOT NULL DEFAULT 0,
    buy_price       REAL    NOT NULL,
    sell_price      REAL    NOT NULL,
    order_size_usd  REAL    NOT NULL,
    pnl             REAL    NOT NULL,
    fee             REAL    NOT NULL DEFAULT 0,
    anchor_at_trade REAL,
    close_reason    TEXT    NOT NULL DEFAULT 'grid',
    opened_at       INTEGER NOT NULL,
    closed_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pepe_grid_epoch_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id     INTEGER NOT NULL REFERENCES pepe_grid_config(id),
    grid_epoch    INTEGER NOT NULL,
    anchor_price  REAL    NOT NULL,
    grid_interval REAL    NOT NULL,
    interval_pct  REAL    NOT NULL,
    started_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stoch_btc_config (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    k_period       INTEGER NOT NULL DEFAULT 14,
    d_period       INTEGER NOT NULL DEFAULT 3,
    candle_tf      TEXT    NOT NULL DEFAULT '5m',
    order_size_pct REAL    NOT NULL DEFAULT 0.05,
    status         TEXT    NOT NULL DEFAULT 'stopped',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stoch_btc_signals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id    INTEGER NOT NULL REFERENCES stoch_btc_config(id),
    signal_type  TEXT    NOT NULL,
    k_val        REAL    NOT NULL,
    d_val        REAL    NOT NULL,
    price        REAL    NOT NULL,
    triggered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stoch_btc_trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id    INTEGER NOT NULL REFERENCES stoch_btc_config(id),
    buy_price    REAL    NOT NULL,
    sell_price   REAL,
    order_size   REAL    NOT NULL,
    pnl          REAL,
    fee          REAL    NOT NULL DEFAULT 0,
    k_at_buy     REAL    NOT NULL,
    d_at_buy     REAL    NOT NULL,
    k_at_sell    REAL,
    d_at_sell    REAL,
    status       TEXT    NOT NULL DEFAULT 'open',
    opened_at    INTEGER NOT NULL,
    closed_at    INTEGER
);
"""

MIGRATIONS = [
    "ALTER TABLE wallets ADD COLUMN name TEXT",
    "ALTER TABLE positions ADD COLUMN slug TEXT",
    "ALTER TABLE positions ADD COLUMN title TEXT",
    "ALTER TABLE positions ADD COLUMN market_slug TEXT",
    "ALTER TABLE positions ADD COLUMN market_end_date TEXT",
    "ALTER TABLE positions ADD COLUMN last_price REAL",
    "ALTER TABLE positions ADD COLUMN price_tracked_at INTEGER",
    "ALTER TABLE trades ADD COLUMN pnl REAL",
    "ALTER TABLE trades ADD COLUMN title TEXT",
    "ALTER TABLE trades ADD COLUMN market_slug TEXT",
    "ALTER TABLE trades ADD COLUMN close_reason TEXT",
    "ALTER TABLE btc5m_positions ADD COLUMN slug TEXT",
    "ALTER TABLE btc5m_positions ADD COLUMN title TEXT",
    "ALTER TABLE btc5m_trades ADD COLUMN slug TEXT",
    "ALTER TABLE btc5m_trades ADD COLUMN title TEXT",
    "ALTER TABLE arb_trades ADD COLUMN title TEXT",
    "ALTER TABLE arb_trades ADD COLUMN market_slug TEXT",
    "ALTER TABLE pepe_grid_trades ADD COLUMN close_reason TEXT NOT NULL DEFAULT 'grid'",
    "ALTER TABLE grid_config ADD COLUMN order_size_pct REAL",
    "ALTER TABLE pepe_grid_config ADD COLUMN order_size_pct REAL",
    """CREATE TABLE IF NOT EXISTS pepe_grid_epoch_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id     INTEGER NOT NULL REFERENCES pepe_grid_config(id),
    grid_epoch    INTEGER NOT NULL,
    anchor_price  REAL    NOT NULL,
    grid_interval REAL    NOT NULL,
    interval_pct  REAL    NOT NULL,
    started_at    INTEGER NOT NULL
)""",
]
