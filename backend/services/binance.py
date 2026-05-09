import hashlib
import hmac
import time
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


def _sign(params: dict) -> dict:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    signature = hmac.new(
        CONFIG.binance_api_secret.encode(),
        query.encode(),
        hashlib.sha256,
    ).hexdigest()
    return {**params, "signature": signature}


async def get_account_balances() -> dict:
    """
    Returns free balances for USDT, USDC and BTC from the Binance account.
    Requires BINANCE_API_KEY and BINANCE_API_SECRET in .env.
    Returns empty dict if credentials are not configured.
    """
    if not CONFIG.binance_api_key or not CONFIG.binance_api_secret:
        return {}

    client = _get_client()
    params = _sign({"timestamp": int(time.time() * 1000), "recvWindow": 5000})
    resp = await client.get(
        f"{CONFIG.binance_base}/account",
        params=params,
        headers={"X-MBX-APIKEY": CONFIG.binance_api_key},
    )
    resp.raise_for_status()
    data = resp.json()

    balances = {}
    for asset in data.get("balances", []):
        if asset["asset"] in ("USDT", "USDC", "BTC"):
            balances[asset["asset"]] = {
                "free":   float(asset["free"]),
                "locked": float(asset["locked"]),
            }
    return balances


async def fetch_candles(symbol: str, interval: str = "1m", limit: int = 20) -> list[dict]:
    client = _get_client()
    resp = await client.get(
        f"{CONFIG.binance_base}/klines",
        params={"symbol": symbol, "interval": interval, "limit": limit},
    )
    resp.raise_for_status()
    raw = resp.json()
    # Binance kline: [openTime, open, high, low, close, volume, ...]
    return [
        {
            "open_time": int(k[0]),
            "open":      float(k[1]),
            "high":      float(k[2]),
            "low":       float(k[3]),
            "close":     float(k[4]),
            "volume":    float(k[5]),
        }
        for k in raw
    ]
