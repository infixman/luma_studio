"""D1 schema owned by the backend and applied on startup.

The Worker has no filesystem, so the schema lives here rather than in loose
`.sql` files. Every statement must tolerate being run against a database that
already has the change: several isolates can boot at once, and a database that
was migrated by hand before this module existed must converge without error.
"""

import asyncio

from common import MigrationError, d1_rows, utc_timestamp


MIGRATIONS = [
    {
        "name": "0001_create_ibon_print_cache",
        "statements": [
            """CREATE TABLE IF NOT EXISTS ibon_print_cache (
                 id TEXT PRIMARY KEY NOT NULL,
                 pincode TEXT NOT NULL,
                 deadline TEXT NOT NULL,
                 qr_code_svg TEXT NOT NULL,
                 files_json TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 cache_expires_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_ibon_print_cache_expires_at ON ibon_print_cache (cache_expires_at)",
        ],
    },
    {
        "name": "0002_create_admin_auth",
        "statements": [
            """CREATE TABLE IF NOT EXISTS admin_oauth_states (
                 state TEXT PRIMARY KEY NOT NULL,
                 code_verifier TEXT NOT NULL,
                 expires_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_admin_oauth_states_expires_at ON admin_oauth_states (expires_at)",
            """CREATE TABLE IF NOT EXISTS admin_sessions (
                 session_id TEXT PRIMARY KEY NOT NULL,
                 email TEXT NOT NULL,
                 expires_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions (expires_at)",
        ],
    },
    {
        "name": "0003_add_print_settings",
        "add_columns": [("ibon_print_cache", "select_type", "TEXT NOT NULL DEFAULT 'FNOMAL'")],
        "statements": [
            """CREATE TABLE IF NOT EXISTS folder_print_settings (
                 folder_id TEXT PRIMARY KEY NOT NULL,
                 select_type TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
        ],
    },
    {
        # The frontend is deployed separately, so OAuth has to remember which
        # frontend URL the login started from.
        "name": "0004_add_oauth_next_url",
        "add_columns": [("admin_oauth_states", "next_url", "TEXT NOT NULL DEFAULT ''")],
        "statements": [],
    },
]

_lock = asyncio.Lock()
_applied_names: list[str] | None = None


async def _column_exists(env, table: str, column: str) -> bool:
    rows = await d1_rows(env.DB.prepare(f"PRAGMA table_info({table})"))
    return any(row.get("name") == column for row in rows)


async def _add_column(env, table: str, column: str, definition: str):
    if await _column_exists(env, table, column):
        return
    try:
        await env.DB.prepare(f"ALTER TABLE {table} ADD COLUMN {column} {definition}").run()
    except Exception as error:
        # The lock is per isolate, so another isolate can win the race between
        # the probe above and this statement. Losing that race is not a failure.
        if "duplicate column" not in str(error).lower():
            raise


async def _apply_one(env, migration: dict):
    for table, column, definition in migration.get("add_columns", ()):
        await _add_column(env, table, column, definition)
    for statement in migration["statements"]:
        await env.DB.prepare(statement).run()


async def apply_migrations(env) -> list[str]:
    """Bring the database up to date, at most once per isolate."""

    global _applied_names
    if _applied_names is not None:
        return _applied_names

    async with _lock:
        if _applied_names is not None:
            return _applied_names

        try:
            await env.DB.prepare(
                "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)"
            ).run()
            rows = await d1_rows(env.DB.prepare("SELECT name FROM schema_migrations"))
        except Exception as error:
            raise MigrationError("schema_migrations") from error
        already = {row["name"] for row in rows}

        for migration in MIGRATIONS:
            if migration["name"] in already:
                continue
            try:
                await _apply_one(env, migration)
            except Exception as error:
                raise MigrationError(migration["name"]) from error
            await env.DB.prepare("INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?1, ?2)").bind(
                migration["name"], utc_timestamp()
            ).run()

        _applied_names = [migration["name"] for migration in MIGRATIONS]
        return _applied_names
