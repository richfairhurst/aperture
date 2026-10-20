CREATE TABLE IF NOT EXISTS report_discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  candidates_found INTEGER NOT NULL DEFAULT 0,
  failures_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_report_discovery_runs_started_at
  ON report_discovery_runs (started_at DESC);
