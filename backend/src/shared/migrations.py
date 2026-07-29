"""D1 schema owned by the backend and applied on startup.

The Worker has no filesystem, so the schema lives here rather than in loose
`.sql` files. Every statement must tolerate being run against a database that
already has the change: several isolates can boot at once, and a database that
was migrated by hand before this module existed must converge without error.
"""

import asyncio
import re

from shared.common import MigrationError, d1_rows, utc_timestamp


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
    {
        "name": "0013_create_media",
        "statements": [
            # One row per uploaded image. Blocks store the id rather than the
            # URL, so a replaced or renamed object does not leave a page
            # pointing at something that is gone.
            """CREATE TABLE IF NOT EXISTS media (
                 id TEXT PRIMARY KEY NOT NULL,
                 object_key TEXT NOT NULL UNIQUE,
                 file_name TEXT NOT NULL,
                 alt TEXT NOT NULL DEFAULT '',
                 byte_size INTEGER NOT NULL,
                 created_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_media_created ON media (created_at DESC)",
        ],
    },
    {
        "name": "0014_create_email_outbox",
        "statements": [
            # Mail is queued rather than sent where it is decided. The admin
            # Worker can mark an order shipped but has no schedule of its own,
            # and a customer's confirmation must not fail because a third
            # party was slow. Both write here; the public Worker's cron sends.
            """CREATE TABLE IF NOT EXISTS email_outbox (
                 id TEXT PRIMARY KEY NOT NULL,
                 order_id TEXT,
                 kind TEXT NOT NULL,
                 recipient TEXT NOT NULL,
                 subject TEXT NOT NULL,
                 body TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'pending',
                 attempts INTEGER NOT NULL DEFAULT 0,
                 last_error TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL,
                 sent_at INTEGER
               )""",
            "CREATE INDEX IF NOT EXISTS idx_email_outbox_pending ON email_outbox (status, created_at)",
        ],
    },
    {
        # What a shared link looks like in LINE, Facebook or Slack. It lives on
        # the page rather than in the app because the crawlers that read it do
        # not run JavaScript: the storefront Worker has to put these into the
        # HTML before it is sent.
        "name": "0015_add_page_share_metadata",
        "add_columns": [
            ("pages", "share_description", "TEXT NOT NULL DEFAULT ''"),
            # The media object key, not the media id. What ends up in the tag
            # is an absolute URL, and the key is what makes one; an id would
            # mean a second lookup on every crawl.
            ("pages", "share_image_key", "TEXT NOT NULL DEFAULT ''"),
        ],
        "statements": [],
    },
    {
        # Finding a picture again. Folders were the obvious answer and the
        # wrong one: a drawing is both "插畫" and "首頁用", and a folder makes
        # you pick one — plus folders bring moving and "delete the folder with
        # everything in it" along with them.
        "name": "0016_add_media_title_and_tags",
        # `title` sits beside `alt`, not instead of it. Alt is read aloud to
        # somebody who cannot see the picture and depends on where it is used;
        # title is the owner's own label for finding it again. One column for
        # both ends with a screen reader saying "首頁 banner v3".
        "add_columns": [("media", "title", "TEXT NOT NULL DEFAULT ''")],
        "statements": [
            # A table, not a comma-separated column. A string cannot be
            # indexed, cannot answer "which tags already exist" for the
            # autocomplete, and matching inside it crosses tag boundaries —
            # 貓 would find 熊貓. One row per tag makes equality mean equality.
            """CREATE TABLE IF NOT EXISTS media_tags (
                 media_id TEXT NOT NULL,
                 tag TEXT NOT NULL,
                 PRIMARY KEY (media_id, tag)
               )""",
            # The primary key already covers "the tags of one image". This
            # covers the other direction: "the images with this tag", which is
            # what the search does.
            "CREATE INDEX IF NOT EXISTS idx_media_tags_tag ON media_tags (tag)",
        ],
    },
    {
        # Lets the back office frame the real storefront showing a draft.
        #
        # A row rather than a signed token, because the two Workers already
        # share this database: no second secret to distribute, no HMAC to get
        # wrong, and — the part signing cannot do — a token that can be
        # revoked and spent exactly once.
        #
        # Scope is one page and the life is minutes. A leaked token shows one
        # unpublished page for a few minutes, which is the whole blast radius.
        "name": "0017_create_preview_tokens",
        "statements": [
            """CREATE TABLE IF NOT EXISTS preview_tokens (
                 token TEXT PRIMARY KEY NOT NULL,
                 page_id TEXT NOT NULL,
                 expires_at INTEGER NOT NULL
               )""",
            # Swept by expiry, not by page, so minting can clear the dead ones
            # without a second table scan.
            "CREATE INDEX IF NOT EXISTS idx_preview_tokens_expiry ON preview_tokens (expires_at)",
        ],
    },
    {
        # Responsive sizes. The storefront was handing a phone the same 1024px
        # original the owner uploaded, which is somebody else's data plan, not
        # a matter of taste.
        #
        # The variants are made in the browser before the upload. There is no
        # Pillow in a Python Worker and Image Resizing is a paid zone feature,
        # so the Worker could not do it even if we wanted it to — and doing it
        # once at upload time puts the cost on the one person uploading rather
        # than on every customer who loads the page afterwards.
        "name": "0018_add_media_dimensions_and_sizes",
        # The original's own pixels, so the library can say PNG · 1024×1024
        # without fetching the image to measure it. Zero means "not measured":
        # rows from before this migration, and uploads the browser could not
        # decode. An upload is never refused for want of a measurement.
        "add_columns": [
            ("media", "width", "INTEGER NOT NULL DEFAULT 0"),
            ("media", "height", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "statements": [
            # A table rather than three sets of columns on `media`, because the
            # count varies: a 600px drawing gets one variant and a 4000px scan
            # gets three, since nothing is ever scaled up past the original.
            #
            # `object_key` is UNIQUE for the index it brings rather than for
            # the constraint: the public image route asks "is this key ours?"
            # on every request, and that question has to be an indexed equality
            # rather than a scan.
            """CREATE TABLE IF NOT EXISTS media_sizes (
                 media_id TEXT NOT NULL,
                 label TEXT NOT NULL,
                 object_key TEXT NOT NULL UNIQUE,
                 width INTEGER NOT NULL,
                 height INTEGER NOT NULL,
                 byte_size INTEGER NOT NULL,
                 PRIMARY KEY (media_id, label)
               )""",
        ],
    },
    {
        # The footer's brand column: a sentence about the shop, between the
        # mark and the copyright. The link columns were already editable and
        # ran left to right with nothing on the left to anchor them.
        "name": "0019_add_footer_blurb",
        "add_columns": [("site_settings", "footer_blurb", "TEXT NOT NULL DEFAULT ''")],
        "statements": [],
    },
    {
        # Published versions of a page.
        #
        # `pages` and `page_blocks` do not change shape; what changes is what
        # they mean. They were "the page" and they are now "the page's draft".
        # Publishing serialises that draft into one row here, and a customer
        # reads the row with `is_current = 1` — never the draft. Editing a
        # published page therefore stops being something customers watch
        # happen.
        #
        # `payload` is the blocks as JSON: type and config, in order. Not the
        # hydrated response — that would freeze the prices and stock levels of
        # the moment into a record that is about layout.
        "name": "0020_page_versions",
        "statements": [
            """CREATE TABLE IF NOT EXISTS page_versions (
                 id TEXT PRIMARY KEY NOT NULL,
                 page_id TEXT NOT NULL,
                 payload TEXT NOT NULL,
                 published_at INTEGER NOT NULL,
                 published_by TEXT NOT NULL DEFAULT '',
                 is_current INTEGER NOT NULL DEFAULT 0
               )""",
            # Every read is "this page's versions, newest first", and the one
            # read that matters most is "this page's current version".
            "CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(page_id, published_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_page_versions_current ON page_versions(page_id, is_current)",
        ],
    },
    {
        # Every page that was already published had no version row, so it
        # would have gone dark the moment the storefront started reading
        # versions instead of blocks. This publishes each one as it stands.
        #
        # Written as one INSERT..SELECT rather than a loop because a migration
        # cannot call the application code that would normally do it, and two
        # implementations of "serialise a page" is one more than can be kept
        # in step. The shape it writes is the one `pages.snapshot_of` reads:
        # a JSON array of {type, config}. json_group_array over an ordered
        # subquery is what keeps the block order.
        "name": "0021_publish_existing_pages",
        "statements": [
            """INSERT INTO page_versions (id, page_id, payload, published_at, published_by, is_current)
                 SELECT 'v0-' || p.id,
                        p.id,
                        COALESCE(
                          (SELECT json_group_array(json_object('type', b.type, 'config', json(b.config)))
                             FROM (SELECT type, config FROM page_blocks
                                    WHERE page_id = p.id
                                    ORDER BY position, rowid) AS b),
                          '[]'),
                        p.updated_at,
                        '',
                        1
                   FROM pages p
                  WHERE p.status = 'published'
                    AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.page_id = p.id)"""
        ],
    },
    {
        "name": "0022_add_customer_notes",
        "add_columns": [("customers", "notes", "TEXT NOT NULL DEFAULT ''")],
        "statements": [],
    },
    {
        # Custom footer colours stay separate from the curated choice names.
        # The domain only accepts six-digit hex values before these fields can
        # be stored or rendered as inline colours.
        "name": "0023_add_footer_custom_colours",
        "add_columns": [
            ("site_settings", "footer_custom_colour", "TEXT NOT NULL DEFAULT '#ece2d2'"),
            ("site_settings", "footer_custom_text", "TEXT NOT NULL DEFAULT '#2b2622'"),
        ],
        "statements": [],
    },
    {
        # Only used when the header background is the solid custom choice.
        "name": "0024_add_header_custom_colour",
        "add_columns": [
            ("site_settings", "header_custom_colour", "TEXT NOT NULL DEFAULT '#faf7f2'"),
        ],
        "statements": [],
    },
    {
        # Kept separate from the curated dark/light choices so the value can
        # be validated as colour data instead of becoming part of a class name.
        "name": "0025_add_header_custom_text",
        "add_columns": [
            ("site_settings", "header_custom_text", "TEXT NOT NULL DEFAULT '#2b2622'"),
        ],
        "statements": [],
    },
    {
        # Account access and shopping access are different decisions. The
        # original `blocked` column remains the cart/checkout switch so
        # existing deployments keep their current policy.
        "name": "0026_add_customer_access_and_activity",
        "add_columns": [
            ("customers", "account_blocked", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "statements": [
            """CREATE TABLE IF NOT EXISTS customer_events (
                 id TEXT PRIMARY KEY NOT NULL,
                 customer_id TEXT NOT NULL,
                 event_type TEXT NOT NULL,
                 path TEXT NOT NULL DEFAULT '',
                 product_slug TEXT NOT NULL DEFAULT '',
                 product_title TEXT NOT NULL DEFAULT '',
                 quantity INTEGER,
                 created_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_customer_events_customer_time"
            " ON customer_events (customer_id, created_at DESC)",
        ],
    },
    {
        # Phase 1 keeps the existing table and ids, but names the one Offer
        # that needs no customer-facing choice.
        "name": "0027_add_default_product_offers",
        "add_columns": [
            ("product_variants", "is_default", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "statements": [
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_one_default"
            " ON product_variants (product_id) WHERE is_default = 1",
            # Do not guess a default for a real multi-offer product.
            "UPDATE product_variants SET is_default = 1"
            " WHERE product_id IN (SELECT product_id FROM product_variants"
            " GROUP BY product_id HAVING COUNT(*) = 1)",
        ],
    },
    {
        # Phase 2 separates what is sold from what is delivered. An Offer
        # keeps the price; an InventoryItem owns the stock and can be shared
        # by several Offers; a Course is granted rather than shipped. Nothing
        # here records whether a product is physical or digital: that is read
        # off the components, so it cannot drift from what is actually sent.
        #
        # `product_variants.sku` and `.stock` stay for now. They are the
        # rollback path until the read switch in phase 3 is proven, and a
        # dropped column cannot be un-dropped.
        "name": "0028_create_offer_components",
        "statements": [
            """CREATE TABLE IF NOT EXISTS inventory_items (
                 id TEXT PRIMARY KEY NOT NULL,
                 sku TEXT NOT NULL DEFAULT '',
                 title TEXT NOT NULL,
                 stock INTEGER NOT NULL DEFAULT 0,
                 enabled INTEGER NOT NULL DEFAULT 1,
                 archived_at INTEGER,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            # Blank SKUs are still allowed and still common, so the index is
            # partial. Making it total would refuse the second item nobody
            # has given a code to yet.
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_sku"
            " ON inventory_items (sku) WHERE sku != ''",
            "CREATE INDEX IF NOT EXISTS idx_inventory_items_picker ON inventory_items (enabled, title)",
            """CREATE TABLE IF NOT EXISTS courses (
                 id TEXT PRIMARY KEY NOT NULL,
                 slug TEXT NOT NULL,
                 title TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'draft',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_slug ON courses (slug)",
            # component_id points at either table, so no foreign key can hold
            # this together. The domain service validates the target before
            # every write; the index below is only about not adding the same
            # one twice.
            """CREATE TABLE IF NOT EXISTS offer_components (
                 id TEXT PRIMARY KEY NOT NULL,
                 offer_id TEXT NOT NULL,
                 component_type TEXT NOT NULL,
                 component_id TEXT NOT NULL,
                 quantity INTEGER NOT NULL DEFAULT 1,
                 access_days INTEGER,
                 position INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL DEFAULT 0
               )""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_components_target"
            " ON offer_components (offer_id, component_type, component_id)",
            "CREATE INDEX IF NOT EXISTS idx_offer_components_order ON offer_components (offer_id, position)",
            "CREATE INDEX IF NOT EXISTS idx_offer_components_reference"
            " ON offer_components (component_type, component_id)",
            # The backfill reuses the offer's id for the item and derives the
            # component's, so re-running it is a no-op rather than a second
            # copy: there is no mapping table to keep in step, and a row in
            # inventory_items named after an offer is the row that offer used
            # to hold the stock for. Both statements are INSERT OR IGNORE, so
            # a stock figure an admin has since corrected stays corrected.
            """INSERT OR IGNORE INTO inventory_items
                 (id, sku, title, stock, enabled, archived_at, created_at, updated_at)
                 SELECT v.id,
                        v.sku,
                        CASE WHEN v.title = '' THEN p.title ELSE p.title || ' ' || v.title END,
                        v.stock,
                        v.enabled,
                        NULL,
                        CAST(strftime('%s', 'now') AS INTEGER),
                        CAST(strftime('%s', 'now') AS INTEGER)
                   FROM product_variants v
                   JOIN products p ON p.id = v.product_id""",
            """INSERT OR IGNORE INTO offer_components
                 (id, offer_id, component_type, component_id, quantity, access_days, position,
                  created_at, updated_at)
                 SELECT 'oc0-' || v.id,
                        v.id,
                        'inventory',
                        v.id,
                        1,
                        NULL,
                        0,
                        CAST(strftime('%s', 'now') AS INTEGER),
                        CAST(strftime('%s', 'now') AS INTEGER)
                   FROM product_variants v""",
        ],
    },
    {
        # Phase 3: what an order promised, and what a member is owed for it.
        #
        # Fulfilments are snapshots. An offer can change what it grants
        # tomorrow, and re-reading it to find out what an old order was for
        # would rewrite history — including the delivery address it was
        # priced against.
        "name": "0029_create_order_fulfilments",
        "add_columns": [
            ("order_items", "product_id", "TEXT NOT NULL DEFAULT ''"),
            ("order_items", "offer_id", "TEXT NOT NULL DEFAULT ''"),
            ("order_items", "requires_shipping", "INTEGER NOT NULL DEFAULT 1"),
            ("order_items", "contains_course", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "statements": [
            # `variant_id` stays. Existing orders are the only record of what
            # was bought, and a snapshot that loses its own key is not one.
            "UPDATE order_items SET offer_id = variant_id WHERE offer_id = ''",
            """CREATE TABLE IF NOT EXISTS order_fulfillments (
                 id TEXT PRIMARY KEY NOT NULL,
                 order_id TEXT NOT NULL,
                 order_item_id TEXT NOT NULL,
                 fulfillment_type TEXT NOT NULL,
                 target_id TEXT NOT NULL,
                 target_title TEXT NOT NULL,
                 sku TEXT,
                 quantity INTEGER NOT NULL DEFAULT 1,
                 access_days INTEGER,
                 status TEXT NOT NULL DEFAULT 'pending',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE INDEX IF NOT EXISTS idx_order_fulfillments_order"
            " ON order_fulfillments (order_id, fulfillment_type, status)",
            "CREATE INDEX IF NOT EXISTS idx_order_fulfillments_target"
            " ON order_fulfillments (target_id, fulfillment_type)",
            # One row per member per course. Buying the same course twice
            # grants access once; both purchases are recorded as sources.
            # `access_days` is copied from the fulfilment and the clock does
            # not start here — `first_viewed_at` is written by the first
            # successful playback, so a member who has not watched yet has
            # not spent any of their window.
            """CREATE TABLE IF NOT EXISTS course_entitlements (
                 id TEXT PRIMARY KEY NOT NULL,
                 customer_id TEXT NOT NULL,
                 course_id TEXT NOT NULL,
                 granted_at INTEGER NOT NULL,
                 access_days INTEGER,
                 first_viewed_at INTEGER,
                 expires_at INTEGER,
                 revoked_at INTEGER,
                 revoke_reason TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_course_entitlements_member"
            " ON course_entitlements (customer_id, course_id)",
            "CREATE INDEX IF NOT EXISTS idx_course_entitlements_live"
            " ON course_entitlements (customer_id, revoked_at, expires_at)",
            # Why a member has access. The unique key below is the provision
            # key for a payment: a resent callback runs the same INSERT OR
            # IGNORE and changes nothing. It is partial because a gift has no
            # fulfilment to name, and two NULLs must not collide.
            """CREATE TABLE IF NOT EXISTS course_entitlement_sources (
                 id TEXT PRIMARY KEY NOT NULL,
                 entitlement_id TEXT NOT NULL,
                 source_kind TEXT NOT NULL,
                 source_order_fulfillment_id TEXT,
                 actor TEXT,
                 reason TEXT,
                 revoked_at INTEGER,
                 revoked_by TEXT,
                 revoke_reason TEXT,
                 created_at INTEGER NOT NULL
               )""",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_course_entitlement_sources_provision"
            " ON course_entitlement_sources (source_kind, source_order_fulfillment_id)"
            " WHERE source_order_fulfillment_id IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS idx_course_entitlement_sources_entitlement"
            " ON course_entitlement_sources (entitlement_id, revoked_at)",
            # Stops a member paying twice for one grant. Held from checkout,
            # released when the order is cancelled or expires, and kept while
            # the entitlement it produced is still live.
            """CREATE TABLE IF NOT EXISTS course_offer_purchase_locks (
                 customer_id TEXT NOT NULL,
                 offer_id TEXT NOT NULL,
                 order_id TEXT NOT NULL,
                 state TEXT NOT NULL,
                 expires_at INTEGER,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (customer_id, offer_id)
               )""",
            "CREATE INDEX IF NOT EXISTS idx_course_offer_purchase_locks_order"
            " ON course_offer_purchase_locks (order_id)",
        ],
    },
]

_lock = asyncio.Lock()
_applied_names: list[str] | None = None


_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def _check_identifier(value: str, label: str) -> str:
    if not _SAFE_IDENTIFIER.fullmatch(value):
        raise MigrationError(f"unsafe {label}: {value}")
    return value


async def _column_exists(env, table: str, column: str) -> bool:
    _check_identifier(table, "table name")
    rows = await d1_rows(env.DB.prepare(f"PRAGMA table_info({table})"))
    return any(row.get("name") == column for row in rows)


async def _add_column(env, table: str, column: str, definition: str):
    _check_identifier(table, "table name")
    _check_identifier(column, "column name")
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
