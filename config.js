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
  COPY_TRADING: {
    // Close any position older than this many days, regardless of P&L
    MAX_POSITION_AGE_DAYS: 7,
    // Only copy markets that resolve within this many days (skip long-dated markets)
    MAX_MARKET_DAYS_TO_RESOLVE: 14,
    // Never deploy more than this fraction of bankroll in copy positions simultaneously
    MAX_BANKROLL_CONCENTRATION: 0.60,
    // Inactivity: if price moves less than this % over INACTIVITY_DAYS, close
    INACTIVITY_THRESHOLD_PCT: 0.05,
    INACTIVITY_DAYS: 3,
    // Stop-loss: close if position falls more than this % below entry price
    STOP_LOSS_PCT: 0.25,
  },
  AAVE: {
    // USDC supply APY to use when the on-chain API is unavailable
    FALLBACK_APY: 0.05,           // 5 % annual
    // Maximum hours of yield to apply in a single cycle (guards against very long gaps)
    MAX_YIELD_HOURS: 4,
    // Minimum idle bankroll (USDC) required before applying yield
    MIN_IDLE_USDC: 1,
  },
  ARB: {
    // Minimum expected profit (after fees) to trade an opportunity
    MIN_PROFIT_PCT: 0.02,
    // Minimum confidence score (0-1) to trade
    MIN_CONFIDENCE: 0.75,
    // Minimum liquidity (USDC) required on each leg
    MIN_LEG_LIQUIDITY: 500,
    // Maximum simultaneous open arbitrage positions
    MAX_OPEN_POSITIONS: 5,
    // Size per leg as fraction of bankroll
    POSITION_SIZE_PCT: 0.03,
    // How many active markets to scan per run
    SCAN_LIMIT: 500,
    // Minimum price spread below 1.0 to flag a basket opportunity
    BASKET_UNDERPRICED_THRESHOLD: 0.96,
    // Max price spread above 1.0 to flag overpriced basket
    BASKET_OVERPRICED_THRESHOLD: 1.06,
    // Minimum spread compression below 1.0 to flag binary spread anomaly
    SPREAD_ANOMALY_THRESHOLD: 0.97,
  },
};
