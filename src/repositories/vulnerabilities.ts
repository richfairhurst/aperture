import type { Database } from "bun:sqlite";
import { safeHttpUrl } from "../utils/safe-url";
import type { CveRecord } from "../providers/cves";

export type Vulnerability = Omit<CveRecord, "raw"> & {
  id: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type VulnerabilityFilter = {
  severity?: string[];
  minimumCvss?: number;
  publishedWithinHours?: number;
  search?: string;
  sort?: "severity" | "recent" | "cvss";
  limit?: number;
  cursor?: string;
};

export type VulnerabilityPage = {
  vulnerabilities: Vulnerability[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type VulnerabilityRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed";
  recordsFound: number;
  recordsStored: number;
  recordsSkipped: number;
  failuresCount: number;
  errorMessage: string | null;
};

export function canRunVulnerabilityPoll(
  database: Database,
  now: Date,
  cadenceHours: number,
): boolean {
  const latest = getLatestVulnerabilityRun(database);
  if (latest?.status === "running") return false;
  if (!latest || latest.status !== "completed") return true;
  return (
    now.getTime() - Date.parse(latest.finishedAt ?? latest.startedAt) >=
    cadenceHours * 3_600_000
  );
}

export function startVulnerabilityRun(
  database: Database,
  startedAt: string,
): number {
  const result = database
    .query(
      `INSERT INTO vulnerability_runs (started_at, status) VALUES (?, 'running')`,
    )
    .run(startedAt);
  return Number(result.lastInsertRowid);
}

export function finishVulnerabilityRun(
  database: Database,
  id: number,
  input: Omit<VulnerabilityRun, "id" | "startedAt">,
): void {
  database
    .query(
      `UPDATE vulnerability_runs
     SET finished_at = ?, status = ?, records_found = ?, records_stored = ?,
         records_skipped = ?, failures_count = ?, error_message = ?
     WHERE id = ?`,
    )
    .run(
      input.finishedAt,
      input.status,
      input.recordsFound,
      input.recordsStored,
      input.recordsSkipped,
      input.failuresCount,
      input.errorMessage,
      id,
    );
}

export function getLatestVulnerabilityRun(
  database: Database,
): VulnerabilityRun | null {
  const row = database
    .query<VulnerabilityRunRow, []>(
      `SELECT id, started_at, finished_at, status, records_found, records_stored,
            records_skipped, failures_count, error_message
     FROM vulnerability_runs ORDER BY id DESC LIMIT 1`,
    )
    .get();
  return row ? mapRun(row) : null;
}

export function upsertVulnerability(
  database: Database,
  vulnerability: CveRecord,
  seenAt: string,
): void {
  database
    .query(
      `INSERT INTO vulnerabilities (
       cve_id, source_id, title, description, published_at, modified_at,
       cvss_score, severity, cvss_vector, affected_products_json,
       exploitability, mitigation, references_json, raw_json, first_seen_at,
       last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cve_id) DO UPDATE SET
       source_id = excluded.source_id,
       title = excluded.title,
       description = excluded.description,
       published_at = excluded.published_at,
       modified_at = excluded.modified_at,
       cvss_score = excluded.cvss_score,
       severity = excluded.severity,
       cvss_vector = excluded.cvss_vector,
       affected_products_json = excluded.affected_products_json,
       exploitability = excluded.exploitability,
       mitigation = excluded.mitigation,
       references_json = excluded.references_json,
       raw_json = excluded.raw_json,
       last_seen_at = excluded.last_seen_at`,
    )
    .run(
      vulnerability.cveId,
      vulnerability.sourceId,
      vulnerability.title,
      vulnerability.description,
      vulnerability.publishedAt,
      vulnerability.modifiedAt,
      vulnerability.cvssScore,
      vulnerability.severity,
      vulnerability.cvssVector,
      JSON.stringify(vulnerability.affectedProducts),
      vulnerability.exploitability,
      vulnerability.mitigation,
      JSON.stringify(
        vulnerability.references.flatMap((reference) => {
          const safe = safeHttpUrl(reference);
          return safe ? [safe] : [];
        }),
      ),
      JSON.stringify(vulnerability.raw),
      seenAt,
      seenAt,
    );
}

export function purgeExpiredVulnerabilities(
  database: Database,
  cutoff: Date,
): number {
  return database
    .query(
      `DELETE FROM vulnerabilities WHERE published_at IS NOT NULL AND published_at < ?`,
    )
    .run(cutoff.toISOString()).changes;
}

export function listVulnerabilities(
  database: Database,
  filter: VulnerabilityFilter,
  now = new Date(),
): VulnerabilityPage {
  const limit = Math.min(filter.limit ?? 50, 200);
  const conditions = ["1 = 1"];
  const params: Array<string | number> = [];
  if (filter.severity?.length) {
    conditions.push(
      `severity IN (${filter.severity.map(() => "?").join(", ")})`,
    );
    params.push(...filter.severity);
  }
  if (filter.minimumCvss !== undefined) {
    conditions.push("cvss_score >= ?");
    params.push(filter.minimumCvss);
  }
  if (filter.publishedWithinHours !== undefined) {
    conditions.push("published_at >= ?");
    params.push(
      new Date(
        now.getTime() - filter.publishedWithinHours * 3_600_000,
      ).toISOString(),
    );
  }
  if (filter.search?.trim()) {
    conditions.push(
      "(cve_id LIKE ? OR title LIKE ? OR description LIKE ? OR affected_products_json LIKE ?)",
    );
    const search = `%${filter.search.trim()}%`;
    params.push(search, search, search, search);
  }

  const sort = filter.sort ?? "severity";
  const order =
    sort === "recent"
      ? "published_at DESC, cve_id DESC"
      : sort === "cvss"
        ? "cvss_score DESC NULLS LAST, published_at DESC, cve_id DESC"
        : "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, cvss_score DESC NULLS LAST, published_at DESC, cve_id DESC";
  const offset = filter.cursor ? decodeCursor(filter.cursor) : 0;
  const rows = database
    .query<VulnerabilityRow, Array<string | number>>(
      `SELECT id, cve_id, source_id, title, description, published_at, modified_at,
            cvss_score, severity, cvss_vector, affected_products_json,
            exploitability, mitigation, references_json, first_seen_at, last_seen_at
     FROM vulnerabilities WHERE ${conditions.join(" AND ")}
     ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit + 1, offset);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return {
    vulnerabilities: pageRows.map(mapVulnerability),
    hasMore,
    nextCursor: hasMore ? encodeCursor(offset + limit) : null,
  };
}

function mapVulnerability(row: VulnerabilityRow): Vulnerability {
  return {
    id: row.id,
    cveId: row.cve_id,
    sourceId: row.source_id,
    title: row.title,
    description: row.description,
    publishedAt: row.published_at,
    modifiedAt: row.modified_at,
    cvssScore: row.cvss_score,
    severity: row.severity,
    cvssVector: row.cvss_vector,
    affectedProducts: JSON.parse(row.affected_products_json) as string[],
    exploitability: row.exploitability,
    mitigation: row.mitigation,
    references: (JSON.parse(row.references_json) as string[]).flatMap(
      (reference) => {
        const safe = safeHttpUrl(reference);
        return safe ? [safe] : [];
      },
    ),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString("base64url");
}

function decodeCursor(value: string): number {
  try {
    const parsed = Number(Buffer.from(value, "base64url").toString());
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

type VulnerabilityRow = {
  id: number;
  cve_id: string;
  source_id: string;
  title: string;
  description: string;
  published_at: string | null;
  modified_at: string | null;
  cvss_score: number | null;
  severity: Vulnerability["severity"];
  cvss_vector: string | null;
  affected_products_json: string;
  exploitability: string | null;
  mitigation: string | null;
  references_json: string;
  first_seen_at: string;
  last_seen_at: string;
};

type VulnerabilityRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: VulnerabilityRun["status"];
  records_found: number;
  records_stored: number;
  records_skipped: number;
  failures_count: number;
  error_message: string | null;
};

function mapRun(row: VulnerabilityRunRow): VulnerabilityRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    recordsFound: row.records_found,
    recordsStored: row.records_stored,
    recordsSkipped: row.records_skipped,
    failuresCount: row.failures_count,
    errorMessage: row.error_message,
  };
}
