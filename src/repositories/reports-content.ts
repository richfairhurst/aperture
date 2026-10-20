import type { Database } from "bun:sqlite";
import {
  classifyReportTemporalStatus,
  type ReportCandidate,
} from "../reports/domain";
import type { NormalizedReport } from "../reports/normalize";
import { assertHttpUrl, safeHttpUrl } from "../utils/safe-url";

export type ReportRecord = {
  id: number;
  source: string;
  providerReportId: string;
  canonicalUrl: string | null;
  sourceIndexUrl: string | null;
  title: string;
  reportYear: number | null;
  reportType: string;
  sourcePublishedAt: string | null;
  activityStartAt: string | null;
  activityEndAt: string | null;
  observedAt: string;
  updatedAt: string | null;
  temporalClassification: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
};

export type ReportVersionRecord = {
  id: number;
  reportId: number;
  contentHash: string;
  normalizedText: string;
  wordCount: number;
  contentTruncated: boolean;
  contentFormat: "markdown" | "pdf";
  sourceUpdatedAt: string | null;
  ingestedAt: string;
};

export function persistNormalizedReport(
  database: Database,
  normalized: NormalizedReport,
  now = new Date(),
): {
  report: ReportRecord;
  version: ReportVersionRecord;
  versionCreated: boolean;
} {
  return database.transaction(() => {
    const candidate = normalized.candidate;
    const canonicalUrl = assertHttpUrl(candidate.provenance.canonicalUrl);
    const classification = classifyReportTemporalStatus({
      reportType: candidate.provenance.reportType,
      isNewReport: true,
      isUpdatedReport: false,
      sourcePublishedAt: candidate.provenance.sourcePublishedAt,
      activityEndAt: candidate.provenance.activityEndAt,
    });
    database
      .query(
        `INSERT INTO reports (
          source, provider_report_id, canonical_url, source_index_url, title,
          report_year, report_type, source_published_at, activity_start_at,
          activity_end_at, observed_at, updated_at, temporal_classification,
          metadata_json, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source, provider_report_id) DO UPDATE SET
          canonical_url = excluded.canonical_url,
          source_index_url = excluded.source_index_url,
          title = excluded.title,
          report_year = excluded.report_year,
          report_type = excluded.report_type,
          source_published_at = excluded.source_published_at,
          activity_start_at = excluded.activity_start_at,
          activity_end_at = excluded.activity_end_at,
           observed_at = CASE
             WHEN reports.updated_at IS excluded.updated_at
             THEN reports.observed_at
             ELSE excluded.observed_at
           END,
          updated_at = excluded.updated_at,
          temporal_classification = excluded.temporal_classification,
          metadata_json = excluded.metadata_json,
          last_seen_at = excluded.last_seen_at`,
      )
      .run(
        candidate.provenance.source,
        candidate.provenance.providerReportId,
        canonicalUrl,
        normalized.sourceIndexUrl,
        candidate.title,
        candidate.provenance.reportYear,
        candidate.provenance.reportType,
        candidate.provenance.sourcePublishedAt,
        candidate.provenance.activityStartAt,
        candidate.provenance.activityEndAt,
        candidate.provenance.observedAt,
        candidate.provenance.updatedAt,
        classification,
        JSON.stringify(normalized.metadata),
        now.toISOString(),
        now.toISOString(),
      );
    const report = findReport(database, candidate);
    if (!report) throw new Error("Report was not found after upsert");
    const existing = database
      .query(
        "SELECT id FROM report_versions WHERE report_id = ? AND content_hash = ?",
      )
      .get(report.id, normalized.content.contentHash);
    database
      .query(
        `INSERT INTO report_versions (
          report_id, content_hash, normalized_text, word_count,
          content_truncated, content_format, source_updated_at, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (report_id, content_hash) DO NOTHING`,
      )
      .run(
        report.id,
        normalized.content.contentHash,
        normalized.content.normalizedText,
        normalized.content.wordCount,
        normalized.content.contentTruncated ? 1 : 0,
        normalized.contentFormat,
        candidate.provenance.updatedAt,
        now.toISOString(),
      );
    const version = findReportVersion(
      database,
      report.id,
      normalized.content.contentHash,
    );
    if (!version) throw new Error("Report version was not found after insert");
    return { report, version, versionCreated: existing === null };
  })();
}

export function findReport(
  database: Database,
  candidate: ReportCandidate,
): ReportRecord | null {
  const row = database
    .query<ReportRow, [string, string]>(
      "SELECT * FROM reports WHERE source = ? AND provider_report_id = ?",
    )
    .get(candidate.provenance.source, candidate.provenance.providerReportId);
  return row ? mapReport(row) : null;
}

function findReportVersion(
  database: Database,
  reportId: number,
  contentHash: string,
): ReportVersionRecord | null {
  const row = database
    .query<ReportVersionRow, [number, string]>(
      "SELECT * FROM report_versions WHERE report_id = ? AND content_hash = ?",
    )
    .get(reportId, contentHash);
  return row ? mapVersion(row) : null;
}

type ReportRow = {
  id: number;
  source: string;
  provider_report_id: string;
  canonical_url: string;
  source_index_url: string | null;
  title: string;
  report_year: number | null;
  report_type: string;
  source_published_at: string | null;
  activity_start_at: string | null;
  activity_end_at: string | null;
  observed_at: string;
  updated_at: string | null;
  temporal_classification: string;
  metadata_json: string;
  created_at: string;
  last_seen_at: string;
};
type ReportVersionRow = {
  id: number;
  report_id: number;
  content_hash: string;
  normalized_text: string;
  word_count: number;
  content_truncated: number;
  content_format: "markdown" | "pdf";
  source_updated_at: string | null;
  ingested_at: string;
};

function mapReport(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    source: row.source,
    providerReportId: row.provider_report_id,
    canonicalUrl: safeHttpUrl(row.canonical_url),
    sourceIndexUrl: safeHttpUrl(row.source_index_url),
    title: row.title,
    reportYear: row.report_year,
    reportType: row.report_type,
    sourcePublishedAt: row.source_published_at,
    activityStartAt: row.activity_start_at,
    activityEndAt: row.activity_end_at,
    observedAt: row.observed_at,
    updatedAt: row.updated_at,
    temporalClassification: row.temporal_classification,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapVersion(row: ReportVersionRow): ReportVersionRecord {
  return {
    id: row.id,
    reportId: row.report_id,
    contentHash: row.content_hash,
    normalizedText: row.normalized_text,
    wordCount: row.word_count,
    contentTruncated: row.content_truncated === 1,
    contentFormat: row.content_format,
    sourceUpdatedAt: row.source_updated_at,
    ingestedAt: row.ingested_at,
  };
}
