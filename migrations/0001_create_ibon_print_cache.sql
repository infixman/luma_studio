CREATE TABLE IF NOT EXISTS ibon_print_cache (
  id TEXT PRIMARY KEY NOT NULL,
  pincode TEXT NOT NULL,
  deadline TEXT NOT NULL,
  qr_code_svg TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cache_expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ibon_print_cache_expires_at
  ON ibon_print_cache (cache_expires_at);

