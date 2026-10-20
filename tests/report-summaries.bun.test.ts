import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { persistReportSummary } from "../src/repositories/report-summaries";
import { reportSummaryPromptVersion } from "../src/reports/summary";

describe("report summary persistence", () => {
  it("stores the structured intellectual summary idempotently", async () => {
    const database = await openDatabase(":memory:");
    database
      .query(
        "INSERT INTO reports (source, provider_report_id, canonical_url, title, report_type, observed_at, temporal_classification, metadata_json, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "orkl",
        "r-summary",
        "https://example.com/r",
        "Report",
        "research",
        "2026-10-14",
        "new_activity",
        "{}",
        "2026-10-14",
        "2026-10-14",
      );
    const reportId = Number(
      database
        .query<{ id: number }, []>("SELECT last_insert_rowid() AS id")
        .get()?.id,
    );
    database
      .query(
        "INSERT INTO report_versions (report_id, content_hash, normalized_text, word_count, content_format, ingested_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(reportId, "hash-summary", "Content", 1, "markdown", "2026-10-14");
    const versionId = Number(
      database
        .query<{ id: number }, []>("SELECT last_insert_rowid() AS id")
        .get()?.id,
    );
    const result = {
      provider: "openai",
      model: "test",
      promptVersion: reportSummaryPromptVersion,
      readVerdict: "read_now" as const,
      summary: "Summary",
      oneSentenceSummary: "One sentence",
      keyTakeaways: ["a", "b", "c"],
      importantFindings: ["finding"],
      deepInsights: ["a", "b", "c"],
      mentalModels: ["model"],
      practicalImplications: ["a", "b"],
      recommendations: ["a", "b"],
      methodologyAndLimitations: "Limits",
      activityContext: "Context",
      quotes: [],
      references: [],
      rawResponse: {},
      usage: null,
      generatedAt: "2026-10-14",
    };
    const id = persistReportSummary(database, versionId, result);
    expect(id).toBeGreaterThan(0);
    expect(
      database.query("SELECT COUNT(*) AS count FROM report_summaries").get(),
    ).toEqual({ count: 1 });
    database.close();
  });
});
