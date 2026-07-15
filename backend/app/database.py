from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any


LOGGER = logging.getLogger(__name__)
SCHEMA_PATH = Path(__file__).with_name("schema.sql")
VECTOR_DIMENSIONS = 1536


@dataclass(frozen=True)
class DatabaseSettings:
    url: str | None
    host: str
    port: int
    name: str
    user: str
    password: str | None
    ssl: bool
    min_pool_size: int
    max_pool_size: int
    connect_timeout_seconds: float
    command_timeout_seconds: float
    application_name: str


@dataclass
class DatabaseState:
    pool: Any | None = None
    vector_enabled: bool = False


def import_asyncpg() -> Any:
    try:
        return import_module("asyncpg")
    except ModuleNotFoundError as exc:
        raise RuntimeError("asyncpg is required for PostgreSQL access. Install backend requirements first.") from exc


def parse_bool(raw: str | None, default: bool = False) -> bool:
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def parse_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return int(raw)


def parse_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return float(raw)


def load_database_settings() -> DatabaseSettings:
    return DatabaseSettings(
        url=os.getenv("DATABASE_URL") or None,
        host=os.getenv("DATABASE_HOST") or "127.0.0.1",
        port=parse_int("DATABASE_PORT", 5432),
        name=os.getenv("DATABASE_NAME") or os.getenv("POSTGRES_DB") or "MeetingMate",
        user=os.getenv("DATABASE_USER") or os.getenv("POSTGRES_USER") or "mm",
        password=os.getenv("DATABASE_PASSWORD") or os.getenv("POSTGRES_PASSWORD") or None,
        ssl=parse_bool(os.getenv("DATABASE_SSL"), default=False),
        min_pool_size=parse_int("DATABASE_MIN_POOL_SIZE", 1),
        max_pool_size=parse_int("DATABASE_MAX_POOL_SIZE", 10),
        connect_timeout_seconds=parse_float("DATABASE_CONNECT_TIMEOUT_SECONDS", 5.0),
        command_timeout_seconds=parse_float("DATABASE_COMMAND_TIMEOUT_SECONDS", 30.0),
        application_name=os.getenv("DATABASE_APPLICATION_NAME") or "MeetingMate backend",
    )


async def connect_database(settings: DatabaseSettings) -> DatabaseState:
    asyncpg = import_asyncpg()
    kwargs: dict[str, Any] = {
        "min_size": settings.min_pool_size,
        "max_size": settings.max_pool_size,
        "timeout": settings.connect_timeout_seconds,
        "command_timeout": settings.command_timeout_seconds,
        "server_settings": {"application_name": settings.application_name},
    }
    if settings.url:
        kwargs["dsn"] = settings.url
    else:
        kwargs.update(
            {
                "host": settings.host,
                "port": settings.port,
                "database": settings.name,
                "user": settings.user,
            }
        )
        if settings.password:
            kwargs["password"] = settings.password
    if settings.ssl:
        kwargs["ssl"] = True

    pool = await asyncpg.create_pool(**kwargs)
    vector_enabled = await initialize_database(pool)
    return DatabaseState(pool=pool, vector_enabled=vector_enabled)


async def close_database(state: DatabaseState) -> None:
    if state.pool:
        await state.pool.close()


async def initialize_database(pool: Any) -> bool:
    schema_sql = SCHEMA_PATH.read_text(encoding="utf-8")
    async with pool.acquire() as connection:
        await connection.execute("SELECT 1")
        await connection.execute(schema_sql)
        vector_enabled = await initialize_pgvector(connection)
        await connection.execute(
            "INSERT INTO schema_migrations(version) VALUES('0001_initial') ON CONFLICT (version) DO NOTHING"
        )
        return vector_enabled


async def initialize_pgvector(connection: Any) -> bool:
    asyncpg = import_asyncpg()
    try:
        await connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS block_embeddings (
                id BIGSERIAL PRIMARY KEY,
                resource_type TEXT NOT NULL CHECK (resource_type IN ('manuscript', 'document')),
                resource_id TEXT NOT NULL,
                block_id TEXT NOT NULL,
                owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                model TEXT NOT NULL,
                embedding vector({VECTOR_DIMENSIONS}) NOT NULL,
                metadata JSONB NOT NULL DEFAULT '{{}}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE(resource_type, resource_id, block_id, model)
            )
            """
        )
    except asyncpg.PostgresError as exc:
        LOGGER.warning("pgvector is unavailable; block_embeddings table was not created: %s", exc)
        return False
    return True


async def check_database(state: DatabaseState) -> bool:
    if not state.pool:
        return False
    async with state.pool.acquire() as connection:
        return await connection.fetchval("SELECT 1") == 1
