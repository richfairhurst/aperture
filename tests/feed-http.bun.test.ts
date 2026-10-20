import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { createRequestHandler } from "../src/http/app";
import { rankStories } from "../src/pipeline/rank";
import { enforceTriage } from "../src/pipeline/triage";
import {
  createNormalizedDocumentVersion,
  upsertDocument,
} from "../src/repositories/documents";
import { persistFeedItem } from "../src/repositories/feed";
import type { ValidatedJevResponse } from "../src/validation/jev";

const jev: ValidatedJevResponse = {
  model: "jev-1.13.0",
  answers: {
    primary_topic: {
      type: "choice",
      choice: "ai",
      confidence: 1,
      probabilities: {
        ai: 1,
        cybersecurity: 0,
        geopolitics: 0,
        technology_strategy: 0,
        executive_decision_making: 0,
        business_opportunity: 0,
        other: 0,
      },
    },
    content_type: {
      type: "choice",
      choice: "analysis",
      confidence: 1,
      probabilities: {
        analysis: 1,
        news: 0,
        research: 0,
        opinion: 0,
        how_to: 0,
        interview: 0,
        announcement: 0,
        other: 0,
      },
    },
    quality_score: score(3),
    personal_utility_score: score(4),
    actionability_score: score(3),
  },
  usage: { inputTokens: null, outputTokens: null },
  rawResponse: { fixture: true },
};

function score(value: number) {
  return {
    type: "score" as const,
    score: value,
    confidence: 1,
    probabilities: {
      "0": 0,
      "1": 0,
      "2": 0,
      "3": value === 3 ? 1 : 0,
      "4": value === 4 ? 1 : 0,
    },
    legend: null,
  };
}

describe("evaluated feed HTTP route", () => {
  it("returns ranked labels, scores, triage, and summary status", async () => {
    const database = await openDatabase(":memory:");
    const document = upsertDocument(database, {
      sourceName: "rss",
      sourceItemId: "doc-1",
      readwiseId: "doc-1",
      sourceUrl: "https://example.com/article",
      readwiseUrl: null,
      title: "Evaluated article",
      author: "Author",
      siteName: "Example",
      category: "article",
      publishedDate: "2026-10-06T10:00:00Z",
      savedAt: null,
      createdAt: "2026-10-06T11:00:00Z",
      updatedAt: "2026-10-06T11:00:00Z",
      createdTimestamp: "2026-10-06T11:00:00Z",
      updatedTimestamp: "2026-10-06T11:00:00Z",
    }).document;
    const version = createNormalizedDocumentVersion(database, {
      documentId: document.id,
      normalizedText: "Text",
      sourceUpdatedTimestamp: document.updatedTimestamp,
      ingestedAt: "2026-10-06T11:01:00Z",
    }).version;
    const rankedStory = rankStories([
      {
        storyId: "doc-1",
        qualityScore: 3,
        personalUtilityScore: 4,
        actionabilityScore: 3,
        triageState: "read_now",
        firstPublicAt: null,
        sourcePublishedAt: document.publishedDate,
      },
    ])[0]!;
    const triageDecision = enforceTriage({
      proposedState: "read_now",
      proposedReason: "Useful",
      personalUtilityScore: 4,
      actionabilityScore: 3,
      strategicImplication: null,
      evidenceStatus: "unverified",
      freshnessStatus: "unverified",
      promotionalSignal: false,
      profileMatchSignal: "strong",
      duplicate: false,
      consequential: false,
      finalScore: rankedStory.finalScore,
    });
    persistFeedItem(database, {
      documentVersionId: version.id,
      profileVersion: "profile-v1",
      rubricVersion: "rubric-v1",
      promptVersion: "prompt-v1",
      jev,
      rankedStory,
      triageDecision,
      freshnessStatus: "unverified",
      freshnessConfidence: "low",
      evidenceStatus: "unverified",
      sourceCount: 1,
      independentSourceCount: 0,
      createdAt: "2026-10-06T11:02:00Z",
    });
    const handler = createRequestHandler({ database });

    const response = await handler(
      new Request(
        "http://localhost/api/feed?topic=ai&minimumUtility=3&minimumFinalScore=70",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(0);
    expect(body).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    expect(body).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    expect(body.stories).toEqual([]);

    const sourceFilteredResponse = await handler(
      new Request("http://localhost/api/feed?sourceName=rss&category=article"),
    );
    const sourceFilteredBody = await sourceFilteredResponse.json();
    expect(sourceFilteredResponse.status).toBe(200);
    expect(sourceFilteredBody.count).toBe(0);
    expect(sourceFilteredBody.stories).toEqual([]);

    database
      .query(
        "UPDATE documents SET published_date = ?, created_at = ? WHERE id = ?",
      )
      .run(
        new Date().toISOString().slice(0, 10),
        new Date().toISOString(),
        document.id,
      );
    database
      .query("UPDATE feed_items SET publication_status = 'published'")
      .run();
    const dateOnlyResponse = await handler(
      new Request("http://localhost/api/feed?timeWindow=1h"),
    );
    const dateOnlyBody = await dateOnlyResponse.json();
    expect(dateOnlyResponse.status).toBe(200);
    expect(dateOnlyBody.count).toBe(1);
    expect(JSON.stringify(body)).not.toContain("Text");

    database
      .query(
        "UPDATE documents SET published_date = ?, created_at = ? WHERE id = ?",
      )
      .run("2026-10-01T00:00:00.000Z", new Date().toISOString(), document.id);
    const recentlyAddedResponse = await handler(
      new Request("http://localhost/api/feed?timeWindow=1h"),
    );
    expect(recentlyAddedResponse.status).toBe(200);
    expect((await recentlyAddedResponse.json()).count).toBe(1);

    database
      .query(
        "UPDATE documents SET published_date = ?, created_at = ? WHERE id = ?",
      )
      .run(
        new Date().toISOString(),
        new Date(Date.now() - 2 * 86_400_000).toISOString(),
        document.id,
      );
    const oldAddedResponse = await handler(
      new Request("http://localhost/api/feed?timeWindow=1h"),
    );
    expect(oldAddedResponse.status).toBe(200);
    expect((await oldAddedResponse.json()).count).toBe(0);

    const invalidCursorResponse = await handler(
      new Request("http://localhost/api/feed?cursor=invalid"),
    );
    expect(invalidCursorResponse.status).toBe(400);

    const invalidTimeWindowResponse = await handler(
      new Request("http://localhost/api/feed?timeWindow=2d"),
    );
    expect(invalidTimeWindowResponse.status).toBe(400);
    database.close();
  });
});
