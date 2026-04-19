import httpx
from config import CONFIG
from logger import logger

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={"Accept": "application/json"},
            timeout=30.0,
        )
    return _client


async def _get(url: str, params: dict | None = None) -> dict | list:
    client = _get_client()
    logger.debug("api:get", {"url": url, "params": params})
    resp = await client.get(url, params=params or {})
    resp.raise_for_status()
    return resp.json()


async def get_wallet_positions(address: str) -> list:
    data = await _get(f"{CONFIG.data_api}/positions", {"user": address, "sizeThreshold": "0.01"})
    return data if isinstance(data, list) else (data.get("data") or [])


async def get_wallet_trades(address: str, limit: int = 500) -> list:
    data = await _get(f"{CONFIG.data_api}/activity", {"user": address, "limit": limit})
    return data if isinstance(data, list) else (data.get("data") or [])


async def get_wallet_pnl(address: str) -> dict | None:
    try:
        data = await _get(f"{CONFIG.data_api}/portfolio-performance", {"address": address})
        return data if isinstance(data, dict) else None
    except Exception:
        return None


async def get_market(condition_id: str) -> dict | None:
    data = await _get(f"{CONFIG.gamma_base}/markets", {"condition_id": condition_id})
    markets = data if isinstance(data, list) else (data.get("data") or [])
    return next((m for m in markets if m.get("conditionId") == condition_id), None)


async def get_market_by_slug(slug: str) -> dict | None:
    for closed in ("false", "true"):
        data = await _get(f"{CONFIG.gamma_base}/markets", {"slug": slug, "closed": closed})
        markets = data if isinstance(data, list) else (data.get("data") or [])
        if markets:
            return markets[0]
    return None


async def get_active_markets(limit: int = 100, offset: int = 0) -> list:
    data = await _get(
        f"{CONFIG.gamma_base}/markets",
        {"active": "true", "closed": "false", "limit": limit, "offset": offset},
    )
    return data if isinstance(data, list) else (data.get("data") or [])


async def get_midpoint_price(token_id: str) -> float:
    data = await _get(f"{CONFIG.clob_base}/midpoint", {"token_id": token_id})
    return float(data.get("mid", 0))


async def get_5m_markets(base_slug: str) -> list:
    import time
    now_sec = int(time.time())
    current_window = (now_sec // 300) * 300
    windows = [current_window, current_window + 300, current_window + 600]

    markets = []
    for ts in windows:
        slug = f"{base_slug}-{ts}"
        try:
            data = await _get(f"{CONFIG.gamma_base}/markets", {"slug": slug})
            batch = data if isinstance(data, list) else (data.get("data") or [])
            markets.extend(batch)
        except Exception:
            pass
    return markets


async def get_leaderboard(limit: int = 50, offset: int = 0) -> list:
    data = await _get(f"{CONFIG.gamma_base}/leaderboard", {"limit": limit, "offset": offset})
    return data if isinstance(data, list) else (data.get("data") or [])
