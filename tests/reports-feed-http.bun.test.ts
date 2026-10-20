import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { createRequestHandler } from "../src/http/app";

function insertReport(
  database: Awaited<ReturnType<typeof openDatabase>>,
  input: {
    id: string;
    source: string;
    score: number;
    observedAt: string;
    type: string;
  },
) {
  database
    .query(
      "INSERT INTO reports (source, provider_report_id, canonical_url, title, report_type, report_year, observed_at, temporal_classification, metadata_json, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.source,
      input.id,
      `https://example.com/${input.id}`,
      `${input.source} report`,
      input.type,
      2026,
      input.observedAt,
      "new_activity",
      "{}",
      input.observedAt,
      input.observedAt,
    );
  const reportId = Number(
    database.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()
      ?.id,
  );
  database
    .query(
      "INSERT INTO report_versions (report_id, content_hash, normalized_text, word_count, content_format, ingested_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(reportId, input.id, "Evidence", 1, "markdown", input.observedAt);
  const versionId = Number(
    database.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()
      ?.id,
  );
  database
    .query(
      "INSERT INTO report_evaluations (report_version_id, rubric_version, prompt_version, ranking_config_version, report_type, primary_topic, activity_status, quality_score, methodology_quality_score, strategic_relevance_score, novelty_score, decision_utility_score, contains_evidence, primarily_promotional, final_score, raw_response_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      versionId,
      "report-rubric-v1",
      "report-prompt-v1",
      "report-ranking-v1",
      input.type,
      "cybersecurity",
      "new_activity",
      3,
      3,
      4,
      3,
      4,
      1,
      0,
      input.score,
      "{}",
      input.observedAt,
    );
  database
    .query(
      "INSERT INTO report_summaries (report_version_id, provider, model, prompt_version, read_verdict, summary, one_sentence_summary, key_takeaways_json, important_findings_json, deep_insights_json, mental_models_json, practical_implications_json, recommendations_json, methodology_limitations, activity_context, quotes_json, references_json, raw_response_json, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      versionId,
      "openai",
      "test",
      "report-summary-v1",
      "read_now",
      "Summary",
      "One sentence",
      '["Takeaway"]',
      '["Finding"]',
      '["Insight"]',
      '["Model"]',
      '["Implication"]',
      '["Recommendation"]',
      "Limits",
      "Context",
      "[]",
      "[]",
      "{}",
      input.observedAt,
    );
}

describe("reports API", () => {
  it("returns only the three-day discovery window and supports filters and pagination", async () => {
    const database = await openDatabase(":memory:");
    insertReport(database, {
      id: "new-1",
      source: "rosti",
      score: 90,
      observedAt: "2026-10-14T10:00:00Z",
      type: "threat_intelligence",
    });
    insertReport(database, {
      id: "new-2",
      source: "orkl",
      score: 80,
      observedAt: "2026-10-14T09:00:00Z",
      type: "research",
    });
    insertReport(database, {
      id: "old",
      source: "rosti",
      score: 99,
      observedAt: "2026-10-10T10:00:00Z",
      type: "threat_intelligence",
    });
    const handler = createRequestHandler({
      database,
      reportsNow: () => new Date("2026-10-14T12:00:00Z"),
    });
    const response = await handler(
      new Request(
        "http://localhost/api/reports?limit=1&source=rosti&minimumScore=85",
      ),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.reports[0]).toMatchObject({
      source: "rosti",
      finalScore: 90,
      reportType: "threat_intelligence",
    });
    expect(body.reports[0].summary.deepInsights).toEqual(["Insight"]);

    const oneHourResponse = await handler(
      new Request("http://localhost/api/reports?observedWithinHours=1"),
    );
    expect((await oneHourResponse.json()).count).toBe(0);

    const fourHourResponse = await handler(
      new Request("http://localhost/api/reports?observedWithinHours=4"),
    );
    expect((await fourHourResponse.json()).count).toBe(2);

    const threeDayResponse = await handler(
      new Request("http://localhost/api/reports?observedWithinHours=72"),
    );
    expect((await threeDayResponse.json()).count).toBe(2);

    const firstPage = await handler(
      new Request("http://localhost/api/reports?limit=1"),
    );
    const firstBody = await firstPage.json();
    expect(firstBody.hasMore).toBe(true);
    const secondPage = await handler(
      new Request(
        `http://localhost/api/reports?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      ),
    );
    expect((await secondPage.json()).count).toBe(1);

    const emptyResponse = await handler(
      new Request("http://localhost/api/reports?source=github_annual_reports"),
    );
    expect((await emptyResponse.json()).count).toBe(0);
    const invalid = await handler(
      new Request("http://localhost/api/reports?minimumScore=101"),
    );
    expect(invalid.status).toBe(400);
    database.close();
  });
});
