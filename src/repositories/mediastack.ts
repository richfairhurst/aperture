import type { Database } from "bun:sqlite";

export type MediastackDiagnostics = {
  lastSuccessfulRun: string | null;
  nextEligibleRun: string | null;
  lastRunStatus: string | null;
  monthlyQueryCount: number;
  monthlyQueryAllowance: number;
  allowanceExceeded: boolean;
  keywordQueryCounts: Array<{ keyword: string; queryCount: number }>;
};

export function canRunMediastack(
  database: Database,
  now: Date,
  cadenceHours: number,
): boolean {
  const row = database
    .query<{ finished_at: string | null; status: string }, []>(
      `SELECT finished_at, status FROM mediastack_runs
       ORDER BY id DESC LIMIT 1`,
    )
    .get();
  if (row?.status === "running") return false;
  if (row && row.status !== "completed") return true;
  if (!row?.finished_at) return true;
  const lastRun = Date.parse(row.finished_at);
  return (
    Number.isNaN(lastRun) || now.getTime() >= lastRun + cadenceHours * 3_600_000
  );
}

export function startMediastackRun(
  database: Database,
  startedAt: string,
): number {
  const result = database
    .query(
      `INSERT INTO mediastack_runs (started_at, status) VALUES (?, 'running')`,
    )
    .run(startedAt);
  return Number(result.lastInsertRowid);
}

export function finishMediastackRun(
  database: Database,
  runId: number,
  input: {
    finishedAt: string;
    status: "completed" | "failed" | "skipped";
    queriesExecuted: number;
    articlesFound: number;
    errorMessage?: string | null;
  },
): void {
  database
    .query(
      `UPDATE mediastack_runs
       SET finished_at = ?, status = ?, queries_executed = ?, articles_found = ?, error_message = ?
       WHERE id = ?`,
    )
    .run(
      input.finishedAt,
      input.status,
      input.queriesExecuted,
      input.articlesFound,
      input.errorMessage ?? null,
      runId,
    );
}

export function recordMediastackQuery(
  database: Database,
  keyword: string,
  queriedAt: Date,
): void {
  const month = queriedAt.toISOString().slice(0, 7);
  const timestamp = queriedAt.toISOString();
  database.transaction(() => {
    database
      .query(
        `INSERT INTO mediastack_usage (calendar_month, query_count, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT (calendar_month) DO UPDATE SET
           query_count = query_count + 1, updated_at = excluded.updated_at`,
      )
      .run(month, timestamp);
    database
      .query(
        `INSERT INTO mediastack_keyword_usage (calendar_month, keyword, query_count, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (calendar_month, keyword) DO UPDATE SET
           query_count = query_count + 1, updated_at = excluded.updated_at`,
      )
      .run(month, keyword, timestamp);
  })();
}

export function getMediastackDiagnostics(
  database: Database,
  now: Date,
  monthlyQueryAllowance: number,
  cadenceHours = 24,
): MediastackDiagnostics {
  const month = now.toISOString().slice(0, 7);
  const usage = database
    .query<{ query_count: number }, [string]>(
      "SELECT query_count FROM mediastack_usage WHERE calendar_month = ?",
    )
    .get(month);
  const keywordRows = database
    .query<{ keyword: string; query_count: number }, [string]>(
      `SELECT keyword, query_count FROM mediastack_keyword_usage
       WHERE calendar_month = ? ORDER BY keyword ASC`,
    )
    .all(month);
  const lastRun = database
    .query<{ finished_at: string | null; status: string }, []>(
      `SELECT finished_at, status FROM mediastack_runs ORDER BY id DESC LIMIT 1`,
    )
    .get();
  const monthlyQueryCount = usage?.query_count ?? 0;
  const lastSuccessfulRun =
    database
      .query<{ finished_at: string | null }, []>(
        `SELECT finished_at FROM mediastack_runs
         WHERE status = 'completed' AND finished_at IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get()?.finished_at ?? null;
  return {
    lastSuccessfulRun,
    nextEligibleRun:
      lastRun?.status === "running"
        ? null
        : lastSuccessfulRun
          ? new Date(
              Date.parse(lastSuccessfulRun) + cadenceHours * 3_600_000,
            ).toISOString()
          : now.toISOString(),
    lastRunStatus: lastRun?.status ?? null,
    monthlyQueryCount,
    monthlyQueryAllowance,
    allowanceExceeded: monthlyQueryCount > monthlyQueryAllowance,
    keywordQueryCounts: keywordRows.map((row) => ({
      keyword: row.keyword,
      queryCount: row.query_count,
    })),
  };
}

export function recordMediastackDocumentKeyword(
  database: Database,
  documentId: number,
  keyword: string,
): void {
  database
    .query(
      `INSERT OR IGNORE INTO mediastack_document_keywords (document_id, keyword)
       VALUES (?, ?)`,
    )
    .run(documentId, keyword);
}
