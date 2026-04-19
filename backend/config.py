from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../.env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # General
    trading_mode: str = "paper"
    log_level: str = "info"
    db_path: str = "data/state.db"
    api_token: str = "changeme"

    # Bankroll
    paper_bankroll: float = 1000.0
    position_size_pct: float = 0.05
    max_open_positions: int = 10
    slippage_pct: float = 0.003
    fee_pct: float = 0.002

    # Filters
    min_market_liquidity: float = 5000.0
    min_signal_price: float = 0.05
    max_signal_price: float = 0.95
    max_signal_age_hours: int = 2
    min_market_volume_24h: float = 1000.0

    # Discovery
    roster_size: int = 10
    min_closed_positions: int = 20
    min_win_rate: float = 0.55
    min_roi: float = 0.10
    lookback_days: int = 30

    # Copy trading
    max_position_age_days: int = 7
    max_market_days_to_resolve: int = 14
    max_bankroll_concentration: float = 0.60
    inactivity_threshold_pct: float = 0.05
    inactivity_days: int = 3
    stop_loss_pct: float = 0.25

    # Kelly
    min_trades_phase2: int = 50
    min_trades_phase3: int = 500
    half_kelly_mult: float = 0.5
    max_kelly_fraction: float = 0.30
    positions_in_budget: int = 10

    # AAVE
    aave_fallback_apy: float = 0.05
    aave_max_yield_hours: float = 4.0
    aave_min_idle_usdc: float = 1.0

    # Arbitrage
    arb_min_profit_pct: float = 0.02
    arb_min_confidence: float = 0.75
    arb_min_leg_liquidity: float = 500.0
    arb_max_open_positions: int = 5
    arb_position_size_pct: float = 0.03
    arb_scan_limit: int = 500
    arb_basket_underpriced_threshold: float = 0.96
    arb_basket_overpriced_threshold: float = 1.06
    arb_spread_anomaly_threshold: float = 0.97

    # Polymarket APIs
    gamma_base: str = "https://gamma-api.polymarket.com"
    clob_base: str = "https://clob.polymarket.com"
    data_api: str = "https://data-api.polymarket.com"

    # Binance
    binance_base: str = "https://api.binance.us/api/v3"

    # DefiLlama
    defillama_pools_api: str = "https://yields.llama.fi/pools"
    aave_v3_polygon_usdc_pool: str = "1b8b4cdb-0728-42a8-bf13-2c8fea7427ee"


CONFIG = Settings()
