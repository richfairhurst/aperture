CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  provider_report_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  source_index_url TEXT,
  title TEXT NOT NULL,
  report_year INTEGER,
  report_type TEXT NOT NULL,
  source_published_at TEXT,
  activity_start_at TEXT,
  activity_end_at TEXT,
  observed_at TEXT NOT NULL,
  updated_at TEXT,
  temporal_classification TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (source, provider_report_id)
);

CREATE INDEX IF NOT EXISTS idx_reports_last_seen_at
  ON reports (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS report_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  content_truncated INTEGER NOT NULL DEFAULT 0 CHECK (content_truncated IN (0, 1)),
  content_format TEXT NOT NULL CHECK (content_format IN ('markdown', 'pdf')),
  source_updated_at TEXT,
  ingested_at TEXT NOT NULL,
  UNIQUE (report_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_report_versions_report_id
  ON report_versions (report_id, ingested_at DESC);
