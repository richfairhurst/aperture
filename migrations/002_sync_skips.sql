CREATE TABLE IF NOT EXISTS sync_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id INTEGER NOT NULL REFERENCES sync_runs (id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_skips_run_id
  ON sync_skips (sync_run_id);
