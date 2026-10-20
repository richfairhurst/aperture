import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { persistReportEvaluation } from "../src/repositories/report-evaluations";
import {
  reportPromptVersion,
  reportRubricVersion,
} from "../src/reports/evaluate";

type IdRow = { id: number };

describe("report evaluation persistence", () => {
  it("stores a separate report evaluation and ranking configuration", async () => {
    const database = await openDatabase(":memory:");
    database
      .query(
        `INSERT INTO reports (
          source, provider_report_id, canonical_url, title, report_type,
          observed_at, temporal_classification, metadata_json, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "rosti",
        "rosti-eval-1",
        "https://example.com/report",
        "Evaluation report",
        "threat_intelligence",
        "2026-10-14T12:00:00Z",
        "new_activity",
        "{}",
        "2026-10-14T12:00:00Z",
        "2026-10-14T12:00:00Z",
      );
    const reportId = Number(
      database.query<IdRow, []>("SELECT last_insert_rowid() AS id").get()?.id,
    );
    database
      .query(
        `INSERT INTO report_versions (
          report_id, content_hash, normalized_text, word_count,
          content_format, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(reportId, "hash", "Evidence", 1, "markdown", "2026-10-14T12:00:00Z");
    const versionId = Number(
      database.query<IdRow, []>("SELECT last_insert_rowid() AS id").get()?.id,
    );
    const id = persistReportEvaluation(database, versionId, {
      provider: "jev",
      model: "jev-test",
      rubricVersion: reportRubricVersion,
      promptVersion: reportPromptVersion,
      reportType: "threat_intelligence",
      primaryTopic: "cybersecurity",
      activityStatus: "new_activity",
      qualityScore: 3,
      methodologyQualityScore: 3,
      strategicRelevanceScore: 4,
      noveltyScore: 3,
      decisionUtilityScore: 4,
      containsEvidence: true,
      primarilyPromotional: false,
      rawResponse: { fixture: true },
      evaluatedAt: "2026-10-14T12:00:00Z",
    });
    expect(id).toBeGreaterThan(0);
    expect(
      database.query("SELECT COUNT(*) AS count FROM report_evaluations").get(),
    ).toEqual({ count: 1 });
    database.close();
  });
});
