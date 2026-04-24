from fastapi import APIRouter, Depends
from api.auth import require_token
from db.connection import get_db, fetchall

router = APIRouter(prefix="/api/positions", tags=["positions"])


@router.get("")
async def get_positions(_: str = Depends(require_token)):
    db = await get_db()

    copy_positions = await fetchall(db, """
        SELECT p.*, w.score AS wallet_score
        FROM positions p
        LEFT JOIN wallets w ON p.wallet = w.address
        ORDER BY p.opened_at DESC
    """)

    btc5m_positions = await fetchall(db, "SELECT * FROM btc5m_positions ORDER BY opened_at DESC")

    arb_positions = await fetchall(db, """
        SELECT at.*, ao.strategy, ao.description, ao.expected_profit
        FROM arb_trades at
        JOIN arb_opportunities ao ON at.opportunity_id = ao.id
        WHERE at.status = 'open'
        ORDER BY at.opened_at DESC
    """)

    arb_opportunities = await fetchall(db, """
        SELECT ao.*, ag.market_ids
        FROM arb_opportunities ao
        LEFT JOIN arb_groups ag ON ao.group_id = ag.id
        ORDER BY ao.detected_at DESC
        LIMIT 50
    """)

    return {
        "copy_trading":      copy_positions,
        "btc5m":             btc5m_positions,
        "arbitrage":         arb_positions,
        "arb_opportunities": arb_opportunities,
    }
