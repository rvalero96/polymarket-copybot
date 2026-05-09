import httpx
from config import CONFIG
from logger import logger

# USDC native en Polygon (6 decimales)
_USDC_CONTRACT = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
# USDC.e bridged en Polygon (6 decimales) — fallback
_USDC_E_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=10.0)
    return _client


def _balance_of_calldata(address: str) -> str:
    """Encodes balanceOf(address) as EVM calldata."""
    selector = "0x70a08231"
    padded = address.lower().replace("0x", "").zfill(64)
    return selector + padded


async def _erc20_balance(contract: str, wallet: str) -> float:
    client = _get_client()
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [
            {"to": contract, "data": _balance_of_calldata(wallet)},
            "latest",
        ],
        "id": 1,
    }
    resp = await client.post(CONFIG.polygon_rpc_url, json=payload)
    resp.raise_for_status()
    result = resp.json().get("result", "0x0")
    raw = int(result, 16)
    return raw / 1e6  # USDC has 6 decimals


async def get_wallet_balances() -> dict:
    """
    Returns USDC balance (native + bridged) of the configured live wallet on Polygon.
    Returns empty dict if wallet address is not configured.
    """
    if not CONFIG.live_wallet_address:
        return {}

    wallet = CONFIG.live_wallet_address
    try:
        usdc_native = await _erc20_balance(_USDC_CONTRACT, wallet)
    except Exception as e:
        logger.error("wallet:usdc_native:error", {"error": str(e)})
        usdc_native = 0.0

    try:
        usdc_bridged = await _erc20_balance(_USDC_E_CONTRACT, wallet)
    except Exception as e:
        logger.error("wallet:usdc_bridged:error", {"error": str(e)})
        usdc_bridged = 0.0

    return {
        "USDC":   usdc_native,
        "USDC.e": usdc_bridged,
    }
