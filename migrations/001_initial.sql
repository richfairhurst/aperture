CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  readwise_id TEXT UNIQUE,
  source_url TEXT NOT NULL,
  readwise_url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  site_name TEXT,
  category TEXT NOT NULL,
  published_date TEXT,
  saved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_timestamp TEXT NOT NULL,
  updated_timestamp TEXT NOT NULL,
  UNIQUE (source_name, source_item_id)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  content_truncated INTEGER NOT NULL DEFAULT 0 CHECK (content_truncated IN (0, 1)),
  source_updated_timestamp TEXT,
  ingested_at TEXT NOT NULL,
  UNIQUE (document_id, content_hash)
);

CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_version_id INTEGER NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  rubric_version TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  jev_model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  quality_score INTEGER NOT NULL CHECK (quality_score BETWEEN 0 AND 4),
  personal_utility_score INTEGER NOT NULL CHECK (personal_utility_score BETWEEN 0 AND 4),
  actionability_score INTEGER NOT NULL CHECK (actionability_score BETWEEN 0 AND 4),
  final_score REAL NOT NULL,
  primary_topic TEXT NOT NULL,
  content_type TEXT NOT NULL,
  noul_results_json TEXT NOT NULL,
  probabilities_json TEXT NOT NULL,
  confidence_json TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_version_id INTEGER NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  summary_provider TEXT NOT NULL,
  summary_model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  summary TEXT,
  why_it_matters TEXT,
  key_points_json TEXT,
  recommended_action TEXT,
  raw_response_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  generated_at TEXT
);

CREATE TABLE IF NOT EXISTS feed_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_version_id INTEGER NOT NULL REFERENCES document_versions (id) ON DELETE CASCADE,
  evaluation_id INTEGER NOT NULL REFERENCES evaluations (id) ON DELETE CASCADE,
  summary_id INTEGER REFERENCES summaries (id) ON DELETE SET NULL,
  publication_status TEXT NOT NULL CHECK (publication_status IN ('published', 'summary_pending', 'withdrawn')),
  triage_state TEXT NOT NULL CHECK (triage_state IN ('read_now', 'important_context', 'watch', 'archive')),
  triage_reason_code TEXT NOT NULL,
  triage_reason TEXT NOT NULL,
  freshness_status TEXT NOT NULL,
  freshness_confidence TEXT NOT NULL,
  evidence_status TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  independent_source_count INTEGER NOT NULL,
  published_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'command')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  items_found INTEGER NOT NULL DEFAULT 0,
  items_persisted INTEGER NOT NULL DEFAULT 0,
  items_skipped INTEGER NOT NULL DEFAULT 0,
  items_processed INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS processing_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id INTEGER NOT NULL REFERENCES sync_runs (id) ON DELETE CASCADE,
  document_version_id INTEGER REFERENCES document_versions (id) ON DELETE SET NULL,
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  safe_message TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT NOT NULL,
  resolved_at TEXT
);
