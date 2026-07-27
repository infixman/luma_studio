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
    {
        "name": "0005_create_bio_link",
        "statements": [
            # One row, always id = 1. The site has a single bio link page, so a
            # settings row is simpler than a table of profiles nobody creates.
            """CREATE TABLE IF NOT EXISTS bio_link_settings (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 display_name TEXT NOT NULL DEFAULT '',
                 bio TEXT NOT NULL DEFAULT '',
                 avatar_key TEXT,
                 updated_at INTEGER NOT NULL
               )""",
            # Buttons and social icons share this table; `kind` tells them
            # apart. Their fields and ordering logic are identical.
            """CREATE TABLE IF NOT EXISTS bio_link_items (
                 id TEXT PRIMARY KEY NOT NULL,
                 kind TEXT NOT NULL,
                 title TEXT NOT NULL,
                 url TEXT NOT NULL,
                 platform TEXT,
                 position INTEGER NOT NULL,
                 enabled INTEGER NOT NULL DEFAULT 1,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_bio_link_items_kind ON bio_link_items (kind, position)",
            # One row per visitor, per day, per target. The unique index below
            # turns repeat requests into no-op inserts, which is what keeps a
            # public endpoint from being able to burn the D1 write quota that
            # admin sessions also depend on.
            """CREATE TABLE IF NOT EXISTS bio_link_events (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 item_id TEXT,
                 event_type TEXT NOT NULL,
                 day TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 country TEXT,
                 city TEXT,
                 referrer_host TEXT,
                 device TEXT,
                 visitor_hash TEXT NOT NULL
               )""",
            """CREATE UNIQUE INDEX IF NOT EXISTS idx_bio_link_events_unique
                 ON bio_link_events (day, event_type, COALESCE(item_id, ''), visitor_hash)""",
            "CREATE INDEX IF NOT EXISTS idx_bio_link_events_day ON bio_link_events (day, event_type)",
        ],
    },
    {
        # Appearance, and the class schedule read from a public Google
        # Calendar. Both belong to the single settings row.
        "name": "0006_add_bio_link_style_and_calendar",
        "add_columns": [
            ("bio_link_settings", "theme", "TEXT NOT NULL DEFAULT 'warm'"),
            ("bio_link_settings", "button_shape", "TEXT NOT NULL DEFAULT 'rounded'"),
            ("bio_link_settings", "font_style", "TEXT NOT NULL DEFAULT 'sans'"),
            ("bio_link_settings", "calendar_url", "TEXT NOT NULL DEFAULT ''"),
            ("bio_link_settings", "calendar_title", "TEXT NOT NULL DEFAULT '近期課程'"),
            ("bio_link_settings", "calendar_count", "INTEGER NOT NULL DEFAULT 5"),
            ("bio_link_settings", "calendar_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "statements": [],
    },
    {
        # The shop's catalogue. Orders, customers and shipping arrive in later
        # migrations, when there is something that reads them.
        "name": "0007_create_shop",
        "statements": [
            # `slug` is what appears in a customer-facing URL, so it is unique
            # and separate from the id: renaming a product must not have to
            # mean breaking every link anyone saved.
            """CREATE TABLE IF NOT EXISTS products (
                 id TEXT PRIMARY KEY NOT NULL,
                 slug TEXT NOT NULL,
                 title TEXT NOT NULL,
                 description TEXT NOT NULL DEFAULT '',
                 status TEXT NOT NULL DEFAULT 'draft',
                 position INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products (slug)",
            "CREATE INDEX IF NOT EXISTS idx_products_status ON products (status, position)",
            # Prices are whole New Taiwan dollars. PAYUNi's TradeAmt is an
            # integer and retail here has no sub-dollar amounts, so a smaller
            # unit would only add a conversion for rounding to go wrong in.
            """CREATE TABLE IF NOT EXISTS product_variants (
                 id TEXT PRIMARY KEY NOT NULL,
                 product_id TEXT NOT NULL,
                 title TEXT NOT NULL,
                 sku TEXT NOT NULL DEFAULT '',
                 price INTEGER NOT NULL,
                 stock INTEGER NOT NULL DEFAULT 0,
                 position INTEGER NOT NULL,
                 enabled INTEGER NOT NULL DEFAULT 1
               )""",
            "CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants (product_id, position)",
            """CREATE TABLE IF NOT EXISTS product_images (
                 id TEXT PRIMARY KEY NOT NULL,
                 product_id TEXT NOT NULL,
                 r2_key TEXT NOT NULL,
                 alt TEXT NOT NULL DEFAULT '',
                 position INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images (product_id, position)",
        ],
    },
    {
        # Delivery options and what they cost. One row per method, seeded so
        # the shop has something coherent before anyone opens the settings.
        "name": "0008_create_shipping_methods",
        "statements": [
            """CREATE TABLE IF NOT EXISTS shipping_methods (
                 method TEXT PRIMARY KEY NOT NULL,
                 label TEXT NOT NULL,
                 enabled INTEGER NOT NULL DEFAULT 1,
                 fee INTEGER NOT NULL,
                 free_threshold INTEGER,
                 position INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            # INSERT OR IGNORE, so re-running this never overwrites the fees
            # the owner has since set. `free_threshold` starts NULL: a free
            # shipping offer is a decision, not a default.
            """INSERT OR IGNORE INTO shipping_methods (method, label, enabled, fee, free_threshold, position, updated_at)
                 VALUES ('cvs_c2c', '7-11 店到店', 1, 60, NULL, 0, 0)""",
            """INSERT OR IGNORE INTO shipping_methods (method, label, enabled, fee, free_threshold, position, updated_at)
                 VALUES ('home', '宅配到府', 1, 120, NULL, 1, 0)""",
        ],
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


async def applied_migration_names(env) -> list[str]:
    """Report what the database says is applied, without changing anything.

    The public Worker answers /api/health with this. It never applies a
    migration: schema changes belong to the admin deployment, so a mismatch
    here is a deploy-order problem to be seen rather than silently repaired
    by whichever Worker happened to get the request.
    """

    try:
        rows = await d1_rows(env.DB.prepare("SELECT name FROM schema_migrations ORDER BY name"))
    except Exception:
        return []
    return [row["name"] for row in rows]


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
