import os
import aiosqlite
from db.schema import SCHEMA, MIGRATIONS
from config import CONFIG

_dbs: dict[str, aiosqlite.Connection | None] = {"paper": None, "live": None}


async def get_db(mode: str = "paper") -> aiosqlite.Connection:
    global _dbs
    if _dbs.get(mode) is not None:
        return _dbs[mode]

    path = CONFIG.db_path if mode == "paper" else CONFIG.live_db_path
    dir_ = os.path.dirname(path)
    if dir_:
        os.makedirs(dir_, exist_ok=True)

    db = await aiosqlite.connect(path)
    db.row_factory = aiosqlite.Row

    await db.executescript(SCHEMA)

    for migration in MIGRATIONS:
        try:
            await db.execute(migration)
        except Exception:
            pass  # column already exists

    await db.commit()
    _dbs[mode] = db
    return db


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
