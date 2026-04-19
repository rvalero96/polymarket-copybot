import os
import aiosqlite
from db.schema import SCHEMA, MIGRATIONS
from config import CONFIG

_db: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    global _db
    if _db is not None:
        return _db

    os.makedirs(os.path.dirname(CONFIG.db_path), exist_ok=True)

    _db = await aiosqlite.connect(CONFIG.db_path)
    _db.row_factory = aiosqlite.Row

    await _db.executescript(SCHEMA)

    for migration in MIGRATIONS:
        try:
            await _db.execute(migration)
        except Exception:
            pass  # column already exists

    await _db.commit()
    return _db


async def fetchall(db: aiosqlite.Connection, sql: str, params: tuple = ()) -> list[dict]:
    async with db.execute(sql, params) as cursor:
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def fetchone(db: aiosqlite.Connection, sql: str, params: tuple = ()) -> dict | None:
    async with db.execute(sql, params) as cursor:
        row = await cursor.fetchone()
        return dict(row) if row else None


async def execute(db: aiosqlite.Connection, sql: str, params: tuple = ()) -> None:
    await db.execute(sql, params)
    await db.commit()
