import type { Database } from "bun:sqlite";

export type ReportDiscoveryRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  candidatesFound: number;
  failuresCount: number;
  errorMessage: string | null;
  currentSource: string | null;
  currentStage: string | null;
};

export function canRunReportDiscovery(
  database: Database,
  now: Date,
  cadenceHours: number,
): boolean {
  if (!Number.isFinite(cadenceHours) || cadenceHours <= 0) {
    throw new Error("Report cadence must be a positive number");
  }
  const latest = getLatestReportDiscoveryRun(database);
  if (latest?.status === "running") return false;
  if (!latest || latest.status !== "completed") return true;
  return (
    now.getTime() - Date.parse(latest.finishedAt ?? latest.startedAt) >=
    cadenceHours * 3_600_000
  );
}

export function recoverStaleReportDiscoveryRun(
  database: Database,
  now: Date,
  staleAfterMs: number,
): boolean {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error("Report stale-run threshold must be positive");
  }
  const latest = getLatestReportDiscoveryRun(database);
  if (
    !latest ||
    latest.status !== "running" ||
    now.getTime() - Date.parse(latest.startedAt) < staleAfterMs
  ) {
    return false;
  }
  database
    .query(
      `UPDATE report_discovery_runs
       SET finished_at = ?, status = 'failed', failures_count = failures_count + 1,
           error_message = ?, current_source = NULL, current_stage = 'failed'
       WHERE id = ? AND status = 'running'`,
    )
    .run(
      now.toISOString(),
      `Recovered stale report discovery run after ${staleAfterMs}ms`,
      latest.id,
    );
  return true;
}

export function startReportDiscoveryRun(
  database: Database,
  startedAt: string,
): number {
  const result = database
    .query(
      `INSERT INTO report_discovery_runs (started_at, status)
       VALUES (?, 'running')`,
    )
    .run(startedAt);
  return Number(result.lastInsertRowid);
}

export function finishReportDiscoveryRun(
  database: Database,
  id: number,
  input: {
    finishedAt: string;
    status: "completed" | "failed";
    candidatesFound: number;
    failuresCount: number;
    errorMessage?: string | null;
  },
): void {
  database
    .query(
      `UPDATE report_discovery_runs
       SET finished_at = ?, status = ?, candidates_found = ?,
           failures_count = ?, error_message = ?, current_source = NULL,
           current_stage = ?
       WHERE id = ?`,
    )
    .run(
      input.finishedAt,
      input.status,
      input.candidatesFound,
      input.failuresCount,
      input.errorMessage ?? null,
      input.status,
      id,
    );
}

export function updateReportDiscoveryProgress(
  database: Database,
  id: number,
  input: { candidatesFound: number; failuresCount: number },
): void {
  database
    .query(
      `UPDATE report_discovery_runs
       SET candidates_found = ?, failures_count = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(input.candidatesFound, input.failuresCount, id);
}

export function updateReportDiscoveryStage(
  database: Database,
  id: number,
  currentSource: string | null,
  currentStage: string,
): void {
  database
    .query(
      `UPDATE report_discovery_runs
       SET current_source = ?, current_stage = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(currentSource, currentStage, id);
}

export function getLatestReportDiscoveryRun(
  database: Database,
): ReportDiscoveryRun | null {
  const row = database
    .query<ReportDiscoveryRunRow, []>(
      `SELECT id, started_at, finished_at, status, candidates_found,
              failures_count, error_message, current_source, current_stage
       FROM report_discovery_runs ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get();
  return row ? mapRun(row) : null;
}

export function getReportDiscoveryDiagnostics(
  database: Database,
  now: Date,
  cadenceHours: number,
): {
  lastRun: ReportDiscoveryRun | null;
  nextEligibleRun: string | null;
  runningForMs: number | null;
  currentSource: string | null;
  currentStage: string | null;
} {
  const lastRun = getLatestReportDiscoveryRun(database);
  const completedAt = lastRun?.finishedAt;
  return {
    lastRun,
    nextEligibleRun:
      lastRun?.status === "completed" && completedAt
        ? new Date(
            Date.parse(completedAt) + cadenceHours * 3_600_000,
          ).toISOString()
        : now.toISOString(),
    runningForMs:
      lastRun?.status === "running"
        ? Math.max(0, now.getTime() - Date.parse(lastRun.startedAt))
        : null,
    currentSource: lastRun?.currentSource ?? null,
    currentStage: lastRun?.currentStage ?? null,
  };
}

type ReportDiscoveryRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed";
  candidates_found: number;
  failures_count: number;
  error_message: string | null;
  current_source: string | null;
  current_stage: string | null;
};

function mapRun(row: ReportDiscoveryRunRow): ReportDiscoveryRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    candidatesFound: row.candidates_found,
    failuresCount: row.failures_count,
    errorMessage: row.error_message,
    currentSource: row.current_source,
    currentStage: row.current_stage,
  };
}
