import httpx
from config import CONFIG
from logger import logger

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=15.0)
    return _client


async def fetch_spot_price(symbol: str) -> float:
    client = _get_client()
    resp = await client.get(f"{CONFIG.binance_base}/ticker/price", params={"symbol": symbol})
    resp.raise_for_status()
    data = resp.json()
    return float(data["price"])


async def fetch_candles(symbol: str, interval: str = "1m", limit: int = 20) -> list[dict]:
    client = _get_client()
    resp = await client.get(
        f"{CONFIG.binance_base}/klines",
        params={"symbol": symbol, "interval": interval, "limit": limit},
    )
    resp.raise_for_status()
    raw = resp.json()
    # Binance kline: [openTime, open, high, low, close, ...]
    return [
        {
            "open":  float(k[1]),
            "high":  float(k[2]),
            "low":   float(k[3]),
            "close": float(k[4]),
        }
        for k in raw
    ]
