from fastapi import APIRouter, Depends, Query
from api.auth import require_token
from db.connection import get_db, fetchall

router = APIRouter(prefix="/api/trades", tags=["trades"])


@router.get("")
async def get_trades(
    limit: int = Query(default=50, le=500),
    strategy: str = Query(default="all"),
    _: str = Depends(require_token),
):
    db = await get_db()
    result = {}

    if strategy in ("all", "copy_trading"):
        result["copy_trading"] = await fetchall(db,
            "SELECT * FROM trades ORDER BY executed_at DESC LIMIT ?", (limit,)
        )

    if strategy in ("all", "btc5m"):
        result["btc5m"] = await fetchall(db,
            "SELECT * FROM btc5m_trades ORDER BY opened_at DESC LIMIT ?", (limit,)
        )

    if strategy in ("all", "arbitrage"):
        result["arbitrage"] = await fetchall(db, """
            SELECT at.*, ao.strategy AS arb_strategy, ao.description
            FROM arb_trades at
            JOIN arb_opportunities ao ON at.opportunity_id = ao.id
            ORDER BY at.opened_at DESC
            LIMIT ?
        """, (limit,))

    if strategy in ("all", "grid"):
        result["grid"] = await fetchall(db, """
            SELECT gt.id, gt.order_id, gt.buy_price, gt.sell_price, gt.order_size_usd,
                   gt.pnl, gt.fee, gt.opened_at, gt.closed_at, go.level
            FROM grid_trades gt
            JOIN grid_orders go ON gt.order_id = go.id
            ORDER BY gt.closed_at DESC
            LIMIT ?
        """, (limit,))

    return result
