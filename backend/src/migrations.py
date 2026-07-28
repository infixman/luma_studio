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
    {
        # Customers and their orders. Kept apart from the admin's tables in
        # every way that matters: its own session table, its own oauth states,
        # its own cookie name. An admin session and a customer session leaking
        # are not the same size of event.
        "name": "0009_create_customers_and_orders",
        "statements": [
            # Keyed on Google's `sub`, not on the address. An account can
            # change its email; using that as the identity loses the order
            # history the moment somebody does.
            """CREATE TABLE IF NOT EXISTS customers (
                 id TEXT PRIMARY KEY NOT NULL,
                 google_sub TEXT NOT NULL,
                 email TEXT NOT NULL,
                 display_name TEXT NOT NULL DEFAULT '',
                 default_recipient_name TEXT NOT NULL DEFAULT '',
                 default_recipient_phone TEXT NOT NULL DEFAULT '',
                 default_address TEXT NOT NULL DEFAULT '',
                 blocked INTEGER NOT NULL DEFAULT 0,
                 anonymized_at INTEGER,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_google_sub ON customers (google_sub)",
            "CREATE INDEX IF NOT EXISTS idx_customers_email ON customers (email)",
            """CREATE TABLE IF NOT EXISTS customer_sessions (
                 session_id TEXT PRIMARY KEY NOT NULL,
                 customer_id TEXT NOT NULL,
                 expires_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_customer_sessions_expires_at ON customer_sessions (expires_at)",
            """CREATE TABLE IF NOT EXISTS customer_oauth_states (
                 state TEXT PRIMARY KEY NOT NULL,
                 code_verifier TEXT NOT NULL,
                 next_url TEXT NOT NULL DEFAULT '',
                 expires_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_customer_oauth_states_expires_at ON customer_oauth_states (expires_at)",
            # `id` is what the customer sees. What goes to the payment gateway
            # is a per-attempt number in payment_attempts, because a failed
            # payment cannot be retried under the same one.
            """CREATE TABLE IF NOT EXISTS orders (
                 id TEXT PRIMARY KEY NOT NULL,
                 customer_id TEXT NOT NULL,
                 status TEXT NOT NULL,
                 subtotal INTEGER NOT NULL,
                 shipping_fee INTEGER NOT NULL,
                 total INTEGER NOT NULL,
                 shipping_method TEXT NOT NULL,
                 recipient_name TEXT NOT NULL,
                 recipient_phone TEXT NOT NULL,
                 recipient_email TEXT NOT NULL,
                 shipping_address TEXT NOT NULL DEFAULT '',
                 store_id TEXT,
                 store_name TEXT,
                 store_addr TEXT,
                 trade_no TEXT,
                 ship_trade_no TEXT,
                 payment_type INTEGER,
                 invoice_no TEXT,
                 invoice_status TEXT,
                 reserved_until INTEGER,
                 paid_at INTEGER,
                 cancelled_at INTEGER,
                 admin_note TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (customer_id, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, reserved_until)",
            # Titles and prices are snapshots. Renaming a product or changing
            # its price must not rewrite what a receipt from March says.
            """CREATE TABLE IF NOT EXISTS order_items (
                 id TEXT PRIMARY KEY NOT NULL,
                 order_id TEXT NOT NULL,
                 variant_id TEXT NOT NULL,
                 product_title TEXT NOT NULL,
                 variant_title TEXT NOT NULL,
                 unit_price INTEGER NOT NULL,
                 quantity INTEGER NOT NULL,
                 subtotal INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id)",
            """CREATE TABLE IF NOT EXISTS payment_attempts (
                 mer_trade_no TEXT PRIMARY KEY NOT NULL,
                 order_id TEXT NOT NULL,
                 amount INTEGER NOT NULL,
                 status TEXT NOT NULL,
                 created_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_payment_attempts_order ON payment_attempts (order_id, created_at)",
            # Who changed an order to what, and when. Needed the day a payment
            # is disputed, which is not a day to start collecting evidence.
            """CREATE TABLE IF NOT EXISTS order_audit_log (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 order_id TEXT NOT NULL,
                 actor TEXT NOT NULL,
                 action TEXT NOT NULL,
                 from_status TEXT,
                 to_status TEXT,
                 detail TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_order_audit_log_order ON order_audit_log (order_id, created_at)",
        ],
    },
    {
        # Categories are flat and many-to-many, which makes them tags. The
        # menu's nesting is arranged by hand rather than grown from here.
        "name": "0010_create_product_categories",
        "statements": [
            """CREATE TABLE IF NOT EXISTS product_categories (
                 id TEXT PRIMARY KEY NOT NULL,
                 slug TEXT NOT NULL,
                 title TEXT NOT NULL,
                 description TEXT NOT NULL DEFAULT '',
                 position INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_product_categories_slug ON product_categories (slug)",
            "CREATE INDEX IF NOT EXISTS idx_product_categories_position ON product_categories (position)",
            """CREATE TABLE IF NOT EXISTS product_category_links (
                 product_id TEXT NOT NULL,
                 category_id TEXT NOT NULL,
                 PRIMARY KEY (product_id, category_id)
               )""",
            # The primary key answers "which categories is this product in".
            # A category page asks the opposite, which without this index
            # means scanning the whole table.
            "CREATE INDEX IF NOT EXISTS idx_product_category_links_category"
            " ON product_category_links (category_id, product_id)",
        ],
    },
    {
        # Pages the owner builds in the back office, and the blocks they are
        # made of. This migration carries the skeleton; the only block type it
        # is used with at first is plain text.
        "name": "0011_create_pages",
        "statements": [
            """CREATE TABLE IF NOT EXISTS pages (
                 id TEXT PRIMARY KEY NOT NULL,
                 path TEXT NOT NULL,
                 title TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'draft',
                 is_home INTEGER NOT NULL DEFAULT 0,
                 position INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_path ON pages (path)",
            # One home page, guaranteed by the database rather than by the
            # application remembering to clear whoever held it before.
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_home ON pages (is_home) WHERE is_home = 1",
            # `config` is JSON rather than a table per block type: the fields
            # differ wildly between types and nothing ever queries inside them.
            # It is settings, not queryable data.
            """CREATE TABLE IF NOT EXISTS page_blocks (
                 id TEXT PRIMARY KEY NOT NULL,
                 page_id TEXT NOT NULL,
                 type TEXT NOT NULL,
                 config TEXT NOT NULL,
                 position INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_page_blocks_page ON page_blocks (page_id, position)",
        ],
    },
    {
        # The header and footer every page wears, and the menu inside the
        # header. Settings rather than blocks: a header you have to remember
        # to insert is a header you will one day forget to insert.
        "name": "0012_create_site_chrome",
        "add_columns": [
            # Default on, so no existing page loses its chrome when this lands.
            ("pages", "show_header", "INTEGER NOT NULL DEFAULT 1"),
            ("pages", "show_footer", "INTEGER NOT NULL DEFAULT 1"),
        ],
        "statements": [
            # One row, always id = 1 — the same shape as bio_link_settings,
            # because the site is likewise singular.
            """CREATE TABLE IF NOT EXISTS site_settings (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 header_background TEXT NOT NULL DEFAULT 'solid',
                 header_colour TEXT NOT NULL DEFAULT 'cream',
                 header_image_key TEXT,
                 header_height TEXT NOT NULL DEFAULT 'medium',
                 header_text TEXT NOT NULL DEFAULT 'dark',
                 header_logo_size TEXT NOT NULL DEFAULT 'medium',
                 header_sticky INTEGER NOT NULL DEFAULT 1,
                 header_show_cart INTEGER NOT NULL DEFAULT 1,
                 header_show_login INTEGER NOT NULL DEFAULT 1,
                 header_cta_label TEXT NOT NULL DEFAULT '',
                 header_cta_url TEXT NOT NULL DEFAULT '',
                 footer_colour TEXT NOT NULL DEFAULT 'ink',
                 footer_text TEXT NOT NULL DEFAULT 'light',
                 footer_copyright TEXT NOT NULL DEFAULT '',
                 -- JSON, for the same reason page_blocks.config is: edited and
                 -- saved as a whole, never queried into.
                 footer_columns TEXT NOT NULL DEFAULT '[]',
                 footer_socials TEXT NOT NULL DEFAULT '[]',
                 updated_at INTEGER NOT NULL
               )""",
            # `target_kind` plus `target` rather than a finished URL: renaming
            # a page's path must not silently break the menu that points at it.
            """CREATE TABLE IF NOT EXISTS menu_items (
                 id TEXT PRIMARY KEY NOT NULL,
                 parent_id TEXT,
                 label TEXT NOT NULL,
                 target_kind TEXT NOT NULL,
                 target TEXT NOT NULL,
                 position INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_menu_items_parent ON menu_items (parent_id, position)",
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
