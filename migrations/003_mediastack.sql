CREATE TABLE IF NOT EXISTS mediastack_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  queries_executed INTEGER NOT NULL DEFAULT 0,
  articles_found INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS mediastack_usage (
  calendar_month TEXT PRIMARY KEY,
  query_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mediastack_keyword_usage (
  calendar_month TEXT NOT NULL,
  keyword TEXT NOT NULL,
  query_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (calendar_month, keyword)
);

CREATE TABLE IF NOT EXISTS mediastack_document_keywords (
  document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  PRIMARY KEY (document_id, keyword)
);
