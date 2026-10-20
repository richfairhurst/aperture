import type { Database } from "bun:sqlite";
import { safeHttpUrl } from "../utils/safe-url";

export type ReportFeedQuery = {
  source?: string[];
  reportType?: string[];
  topic?: string[];
  temporalClassification?: string[];
  year?: number;
  minimumScore?: number;
  observedWithinHours?: number;
  limit?: number;
  cursor?: string;
  sort?: "score" | "recent";
};

export type ReportFeedPage = {
  reports: ReportFeedItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type ReportFeedItem = {
  id: number;
  versionId: number;
  title: string;
  source: string;
  canonicalUrl: string | null;
  sourceIndexUrl: string | null;
  reportType: string;
  reportYear: number | null;
  sourcePublishedAt: string | null;
  activityStartAt: string | null;
  activityEndAt: string | null;
  observedAt: string;
  temporalClassification: string;
  primaryTopic: string | null;
  finalScore: number | null;
  summary: ReportFeedSummary | null;
};

export type ReportFeedSummary = {
  readVerdict: string;
  summary: string;
  oneSentenceSummary: string;
  keyTakeaways: string[];
  deepInsights: string[];
  mentalModels: string[];
  practicalImplications: string[];
  recommendations: string[];
  methodologyAndLimitations: string;
  activityContext: string;
  quotes: string[];
  references: string[];
};

type ReportRow = {
  id: number;
  version_id: number;
  title: string;
  source: string;
  canonical_url: string;
  source_index_url: string | null;
  report_type: string;
  report_year: number | null;
  source_published_at: string | null;
  activity_start_at: string | null;
  activity_end_at: string | null;
  observed_at: string;
  temporal_classification: string;
  primary_topic: string | null;
  final_score: number | null;
  summary_json: string | null;
};

export function listReportPage(
  database: Database,
  query: ReportFeedQuery = {},
  now = new Date(),
): ReportFeedPage {
  const limit = query.limit ?? 50;
  const sort = query.sort ?? "score";
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Report limit must be an integer from 1 to 200");
  }
  if (sort !== "score" && sort !== "recent") {
    throw new Error("Report sort must be score or recent");
  }
  const hours = query.observedWithinHours ?? 72;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
    throw new Error("Report observed window must be between 0 and 720 hours");
  }

  const conditions = ["r.observed_at >= ?", "r.observed_at <= ?"];
  const parameters: Array<string | number> = [
    new Date(now.getTime() - hours * 3_600_000).toISOString(),
    now.toISOString(),
  ];
  addInFilter(conditions, parameters, "r.source", query.source);
  addInFilter(conditions, parameters, "r.report_type", query.reportType);
  addInFilter(
    conditions,
    parameters,
    "r.temporal_classification",
    query.temporalClassification,
  );
  if (query.topic?.length) {
    conditions.push(
      "e.primary_topic IN (" + query.topic.map(() => "?").join(",") + ")",
    );
    parameters.push(...query.topic);
  }
  if (query.year !== undefined) {
    if (
      !Number.isInteger(query.year) ||
      query.year < 1900 ||
      query.year > 2200
    ) {
      throw new Error("Report year is invalid");
    }
    conditions.push("r.report_year = ?");
    parameters.push(query.year);
  }
  if (query.minimumScore !== undefined) {
    if (
      !Number.isFinite(query.minimumScore) ||
      query.minimumScore < 0 ||
      query.minimumScore > 100
    ) {
      throw new Error("Report minimum score must be between 0 and 100");
    }
    conditions.push("e.final_score >= ?");
    parameters.push(query.minimumScore);
  }

  const cursor = query.cursor ? decodeCursor(query.cursor, sort) : null;
  if (cursor) {
    if (sort === "score") {
      conditions.push(
        "(COALESCE(e.final_score, -1) < ? OR (COALESCE(e.final_score, -1) = ? AND r.id > ?))",
      );
      parameters.push(cursor.score, cursor.score, cursor.id);
    } else {
      conditions.push(
        "(r.last_seen_at < ? OR (r.last_seen_at = ? AND r.id > ?))",
      );
      parameters.push(cursor.date, cursor.date, cursor.id);
    }
  }

  const rows = database
    .query<ReportRow, Array<string | number>>(
      `SELECT r.id, v.id AS version_id, r.title, r.source, r.canonical_url,
              r.source_index_url, r.report_type, r.report_year,
              r.source_published_at, r.activity_start_at, r.activity_end_at,
              r.observed_at, r.temporal_classification,
              e.primary_topic, e.final_score,
              CASE WHEN s.id IS NULL THEN NULL ELSE json_object(
                'readVerdict', s.read_verdict, 'summary', s.summary,
                'oneSentenceSummary', s.one_sentence_summary,
                'keyTakeaways', json(s.key_takeaways_json),
                'deepInsights', json(s.deep_insights_json),
                'mentalModels', json(s.mental_models_json),
                'practicalImplications', json(s.practical_implications_json),
                'recommendations', json(s.recommendations_json),
                'methodologyAndLimitations', s.methodology_limitations,
                'activityContext', s.activity_context,
                'quotes', json(s.quotes_json), 'references', json(s.references_json)
              ) END AS summary_json
       FROM reports r
       JOIN report_versions v ON v.id = (
         SELECT rv.id FROM report_versions rv
         WHERE rv.report_id = r.id ORDER BY rv.ingested_at DESC, rv.id DESC LIMIT 1
       )
       LEFT JOIN report_evaluations e ON e.id = (
         SELECT re.id FROM report_evaluations re
         WHERE re.report_version_id = v.id ORDER BY re.id DESC LIMIT 1
       )
       LEFT JOIN report_summaries s ON s.id = (
         SELECT rs.id FROM report_summaries rs
         WHERE rs.report_version_id = v.id ORDER BY rs.id DESC LIMIT 1
       )
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${sort === "score" ? "COALESCE(e.final_score, -1) DESC, r.id ASC" : "r.last_seen_at DESC, r.id ASC"}
       LIMIT ?`,
    )
    .all(...parameters, limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    reports: pageRows.map(toReportFeedItem),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeURIComponent(
            JSON.stringify({
              sort,
              score: last.final_score ?? -1,
              date: last.observed_at,
              id: last.id,
            }),
          )
        : null,
  };
}

function addInFilter(
  conditions: string[],
  parameters: Array<string | number>,
  column: string,
  values?: string[],
): void {
  if (!values?.length) return;
  conditions.push(`${column} IN (${values.map(() => "?").join(",")})`);
  parameters.push(...values);
}

function decodeCursor(
  value: string,
  sort: "score" | "recent",
): { sort: string; score: number; date: string; id: number } {
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Record<
      string,
      unknown
    >;
    if (
      parsed.sort !== sort ||
      typeof parsed.score !== "number" ||
      typeof parsed.date !== "string" ||
      typeof parsed.id !== "number"
    )
      throw new Error();
    return parsed as { sort: string; score: number; date: string; id: number };
  } catch {
    throw new Error("Report cursor is invalid");
  }
}

function toReportFeedItem(row: ReportRow): ReportFeedItem {
  return {
    id: row.id,
    versionId: row.version_id,
    title: row.title,
    source: row.source,
    canonicalUrl: safeHttpUrl(row.canonical_url),
    sourceIndexUrl: safeHttpUrl(row.source_index_url),
    reportType: row.report_type,
    reportYear: row.report_year,
    sourcePublishedAt: row.source_published_at,
    activityStartAt: row.activity_start_at,
    activityEndAt: row.activity_end_at,
    observedAt: row.observed_at,
    temporalClassification: row.temporal_classification,
    primaryTopic: row.primary_topic,
    finalScore: row.final_score,
    summary: row.summary_json
      ? (JSON.parse(row.summary_json) as ReportFeedSummary)
      : null,
  };
}
