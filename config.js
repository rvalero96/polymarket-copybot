export const CONFIG = {
  TRADING_MODE: process.env.TRADING_MODE || 'paper',
  PAPER_BANKROLL: 1000,
  POSITION_SIZE_PCT: 0.05,
  MAX_OPEN_POSITIONS: 10,
  FILTERS: {
    MIN_MARKET_LIQUIDITY: 5000,
    MIN_SIGNAL_PRICE: 0.05,
    MAX_SIGNAL_PRICE: 0.95,
    MAX_SIGNAL_AGE_HOURS: 2,
    MIN_MARKET_VOLUME_24H: 1000,
  },
  SLIPPAGE_PCT: 0.003,
  FEE_PCT: 0.002,
  DISCOVERY: {
    ROSTER_SIZE: 10,
    MIN_CLOSED_POSITIONS: 20,
    MIN_WIN_RATE: 0.55,
    MIN_ROI: 0.10,
    LOOKBACK_DAYS: 30,
  },
  API: {
    GAMMA_BASE: 'https://gamma-api.polymarket.com',
    CLOB_BASE:  'https://clob.polymarket.com',
    DATA_API:   'https://data-api.polymarket.com',
  },
  STATE_BRANCH: 'paper-state',
  DB_PATH: 'data/state.db',
};
