CREATE TABLE IF NOT EXISTS triage_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluation_id INTEGER NOT NULL UNIQUE REFERENCES evaluations (id) ON DELETE CASCADE,
  proposed_triage_state TEXT NOT NULL CHECK (proposed_triage_state IN ('read_now', 'important_context', 'watch', 'archive')),
  proposed_triage_reason TEXT NOT NULL,
  triage_state TEXT NOT NULL CHECK (triage_state IN ('read_now', 'important_context', 'watch', 'archive')),
  triage_reason_code TEXT NOT NULL,
  triage_reason TEXT NOT NULL,
  enforced_rules_json TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluations_identity
  ON evaluations (
    document_version_id,
    rubric_version,
    profile_version,
    jev_model,
    prompt_version
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_items_evaluation_id
  ON feed_items (evaluation_id);
