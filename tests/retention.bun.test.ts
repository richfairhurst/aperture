import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { purgeExpiredNews } from "../src/pipeline/retention";

const now = "2026-10-07T12:00:00.000Z";

function insertStory(
  database: Awaited<ReturnType<typeof openDatabase>>,
  input: {
    id: string;
    title: string;
    contentType: string;
    publishedDate: string | null;
  },
): void {
  const document = database
    .query(
      `INSERT INTO documents (
        source_name, source_item_id, readwise_id, source_url, readwise_url,
        title, author, site_name, category, published_date, saved_at,
        created_at, updated_at, created_timestamp, updated_timestamp
      ) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 'article', ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      "rss",
      input.id,
      input.id,
      `https://example.com/${input.id}`,
      input.title,
      input.publishedDate,
      now,
      now,
      now,
      now,
    );
  const documentId = Number(document.lastInsertRowid);
  const version = database
    .query(
      `INSERT INTO document_versions (
        document_id, content_hash, normalized_text, word_count,
        content_truncated, source_updated_timestamp, ingested_at
      ) VALUES (?, ?, 'Text', 1, 0, ?, ?)`,
    )
    .run(documentId, `hash-${input.id}`, now, now);
  const versionId = Number(version.lastInsertRowid);
  const evaluation = database
    .query(
      `INSERT INTO evaluations (
        document_version_id, rubric_version, profile_version, jev_model,
        prompt_version, quality_score, personal_utility_score,
        actionability_score, final_score, primary_topic, content_type,
        noul_results_json, probabilities_json, confidence_json,
        raw_response_json, evaluated_at
      ) VALUES (?, 'rubric-v1', 'profile-v1', 'jev-1', 'prompt-v1', 3, 3, 3,
        75, 'ai', ?, '{}', '{}', '{}', '{}', ?)`,
    )
    .run(versionId, input.contentType, now);
  const evaluationId = Number(evaluation.lastInsertRowid);
  const triage = database
    .query(
      `INSERT INTO triage_decisions (
        evaluation_id, proposed_triage_state, proposed_triage_reason,
        triage_state, triage_reason_code, triage_reason,
        enforced_rules_json, profile_version, created_at
      ) VALUES (?, 'watch', 'Test', 'watch', 'test', 'Test', '{}', 'profile-v1', ?)`,
    )
    .run(evaluationId, now);
  void triage;
  database
    .query(
      `INSERT INTO feed_items (
        document_version_id, evaluation_id, summary_id, publication_status,
        triage_state, triage_reason_code, triage_reason, freshness_status,
        freshness_confidence, evidence_status, source_count,
        independent_source_count, published_at
      ) VALUES (?, ?, NULL, 'summary_pending', 'watch', 'test', 'Test',
        'unverified', 'low', 'single_source', 1, 0, ?)`,
    )
    .run(versionId, evaluationId, now);
}

describe("news retention", () => {
  it("deletes expired news and cascades dependent records", async () => {
    const database = await openDatabase(":memory:");
    insertStory(database, {
      id: "expired-news",
      title: "Expired news",
      contentType: "news",
      publishedDate: "2026-10-04T11:59:59.000Z",
    });
    insertStory(database, {
      id: "boundary-news",
      title: "Boundary news",
      contentType: "news",
      publishedDate: "2026-10-04T12:00:00.000Z",
    });
    insertStory(database, {
      id: "old-analysis",
      title: "Old analysis",
      contentType: "analysis",
      publishedDate: "2026-09-01T12:00:00.000Z",
    });
    insertStory(database, {
      id: "undated-news",
      title: "Undated news",
      contentType: "news",
      publishedDate: null,
    });

    const result = purgeExpiredNews(database, new Date(now));

    expect(result).toEqual({
      evaluationsDeleted: 2,
      documentVersionsDeleted: 2,
      documentsDeleted: 2,
    });
    expect(
      database.query("SELECT COUNT(*) AS count FROM documents").get(),
    ).toEqual({ count: 2 });
    expect(
      database.query("SELECT COUNT(*) AS count FROM feed_items").get(),
    ).toEqual({ count: 2 });
    database.close();
  });
});
