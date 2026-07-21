ALTER TABLE ibon_print_cache
  ADD COLUMN select_type TEXT NOT NULL DEFAULT 'FNOMAL';

CREATE TABLE IF NOT EXISTS folder_print_settings (
  folder_id TEXT PRIMARY KEY NOT NULL,
  select_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
