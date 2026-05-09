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


import decimal as _decimal


def _round_step(qty: float, step: float) -> float:
    d = _decimal.Decimal(str(qty))
    s = _decimal.Decimal(str(step))
    return float((d / s).to_integral_value(rounding=_decimal.ROUND_DOWN) * s)


def _round_tick(price: float, tick: float) -> float:
    d = _decimal.Decimal(str(price))
    t = _decimal.Decimal(str(tick))
    return float((d / t).to_integral_value(rounding=_decimal.ROUND_DOWN) * t)


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


async def get_exchange_filters(symbol: str) -> dict:
    """Returns LOT_SIZE stepSize, PRICE_FILTER tickSize and MIN_NOTIONAL for a symbol."""
    client = _get_client()
    resp = await client.get(f"{CONFIG.binance_base}/exchangeInfo", params={"symbol": symbol})
    resp.raise_for_status()
    info = resp.json()
    filters = info["symbols"][0]["filters"]
    result = {"step_size": 0.00001, "tick_size": 0.01, "min_notional": 10.0, "min_qty": 0.0}
    for f in filters:
        if f["filterType"] == "LOT_SIZE":
            result["step_size"] = float(f["stepSize"])
            result["min_qty"]   = float(f["minQty"])
        elif f["filterType"] == "PRICE_FILTER":
            result["tick_size"] = float(f["tickSize"])
        elif f["filterType"] in ("MIN_NOTIONAL", "NOTIONAL"):
            result["min_notional"] = float(f.get("minNotional", f.get("minNotional", 10.0)))
    return result


async def place_limit_order(symbol: str, side: str, quantity: float, price: float) -> dict:
    """Places a LIMIT GTC order. side: 'BUY' or 'SELL'."""
    client = _get_client()
    params = _sign({
        "symbol":      symbol,
        "side":        side,
        "type":        "LIMIT",
        "timeInForce": "GTC",
        "quantity":    f"{quantity:.8f}".rstrip("0").rstrip("."),
        "price":       f"{price:.8f}".rstrip("0").rstrip("."),
        "timestamp":   int(time.time() * 1000),
        "recvWindow":  5000,
    })
    resp = await client.post(
        f"{CONFIG.binance_base}/order",
        params=params,
        headers={"X-MBX-APIKEY": CONFIG.binance_api_key},
    )
    resp.raise_for_status()
    return resp.json()


async def cancel_order(symbol: str, order_id: int) -> dict:
    client = _get_client()
    params = _sign({
        "symbol":    symbol,
        "orderId":   order_id,
        "timestamp": int(time.time() * 1000),
        "recvWindow": 5000,
    })
    resp = await client.delete(
        f"{CONFIG.binance_base}/order",
        params=params,
        headers={"X-MBX-APIKEY": CONFIG.binance_api_key},
    )
    resp.raise_for_status()
    return resp.json()


async def cancel_all_orders(symbol: str) -> list:
    client = _get_client()
    params = _sign({
        "symbol":    symbol,
        "timestamp": int(time.time() * 1000),
        "recvWindow": 5000,
    })
    resp = await client.delete(
        f"{CONFIG.binance_base}/openOrders",
        params=params,
        headers={"X-MBX-APIKEY": CONFIG.binance_api_key},
    )
    resp.raise_for_status()
    return resp.json()


async def get_listen_key() -> str:
    client = _get_client()
    resp = await client.post(
        f"{CONFIG.binance_base}/userDataStream",
        headers={"X-MBX-APIKEY": CONFIG.binance_api_key},
    )
    resp.raise_for_status()
    return resp.json()["listenKey"]


async def keepalive_listen_key(listen_key: str) -> None:
    client = _get_client()
    await client.put(
        f"{CONFIG.binance_base}/userDataStream",
        params={"listenKey": listen_key},
        headers={"X-MBX-APIKEY": CONFIG.binance_api_key},
    )


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
