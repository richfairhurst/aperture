import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { rankStories } from "../src/pipeline/rank";
import { enforceTriage } from "../src/pipeline/triage";
import {
  createNormalizedDocumentVersion,
  upsertDocument,
} from "../src/repositories/documents";
import { persistFeedItem } from "../src/repositories/feed";
import type { ValidatedJevResponse } from "../src/validation/jev";

const evaluatedJev: ValidatedJevResponse = {
  model: "jev-1.13.0",
  answers: {
    primary_topic: {
      type: "choice",
      choice: "ai",
      confidence: 0.9,
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
      confidence: 0.9,
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
    contains_evidence: { type: "noul", noul: 1 },
  },
  usage: { inputTokens: 100, outputTokens: 50 },
  rawResponse: { fixture: true },
};

function score(value: number) {
  return {
    type: "score" as const,
    score: value,
    confidence: 0.8,
    probabilities: {
      "0": value === 0 ? 1 : 0,
      "1": value === 1 ? 1 : 0,
      "2": value === 2 ? 1 : 0,
      "3": value === 3 ? 1 : 0,
      "4": value === 4 ? 1 : 0,
    },
    legend: null,
  };
}

async function createDocumentVersion() {
  const database = await openDatabase(":memory:");
  const document = upsertDocument(database, {
    sourceName: "rss",
    sourceItemId: "doc-1",
    readwiseId: "doc-1",
    sourceUrl: "https://example.com/article",
    readwiseUrl: "https://readwise.io/read/doc-1",
    title: "Example article",
    author: "Example author",
    siteName: "Example site",
    category: "article",
    publishedDate: "2026-10-06T09:00:00Z",
    savedAt: null,
    createdAt: "2026-10-06T10:00:00Z",
    updatedAt: "2026-10-06T10:00:00Z",
    createdTimestamp: "2026-10-06T10:00:00Z",
    updatedTimestamp: "2026-10-06T10:00:00Z",
  }).document;
  const version = createNormalizedDocumentVersion(database, {
    documentId: document.id,
    normalizedText: "A normalized article with evidence.",
    sourceUpdatedTimestamp: document.updatedTimestamp,
    ingestedAt: "2026-10-06T10:01:00Z",
  }).version;

  return { database, version };
}

describe("feed publication repository", () => {
  it("persists evaluation, triage, and summary-pending publication", async () => {
    const { database, version } = await createDocumentVersion();
    const rankedStory = rankStories([
      {
        storyId: "story-1",
        qualityScore: 3,
        personalUtilityScore: 4,
        actionabilityScore: 3,
        triageState: "read_now",
        firstPublicAt: "2026-10-06T09:00:00Z",
        sourcePublishedAt: null,
      },
    ])[0]!;
    const triageDecision = enforceTriage({
      proposedState: "read_now",
      proposedReason: "High utility and actionable.",
      personalUtilityScore: 4,
      actionabilityScore: 3,
      strategicImplication: null,
      evidenceStatus: "single_source",
      freshnessStatus: "new_development",
      promotionalSignal: false,
      profileMatchSignal: "strong",
      duplicate: false,
      consequential: false,
      finalScore: rankedStory.finalScore,
    });

    const result = persistFeedItem(database, {
      documentVersionId: version.id,
      profileVersion: "profile-v1",
      rubricVersion: "rubric-v1",
      promptVersion: "prompt-v1",
      jev: evaluatedJev,
      rankedStory,
      triageDecision,
      freshnessStatus: "new_development",
      freshnessConfidence: "medium",
      evidenceStatus: "single_source",
      sourceCount: 1,
      independentSourceCount: 0,
      createdAt: "2026-10-06T10:02:00Z",
    });

    expect(result.publicationStatus).toBe("summary_pending");
    expect(result.evaluationCreated).toBe(true);
    expect(result.triageDecisionCreated).toBe(true);
    expect(result.feedItemCreated).toBe(true);

    const evaluation = database
      .query<{ quality_score: number; final_score: number }, [number]>(
        "SELECT quality_score, final_score FROM evaluations WHERE id = ?",
      )
      .get(result.evaluationId);
    const feedItem = database
      .query<{ publication_status: string; evidence_status: string }, [number]>(
        "SELECT publication_status, evidence_status FROM feed_items WHERE id = ?",
      )
      .get(result.feedItemId);

    expect(evaluation?.quality_score).toBe(3);
    expect(evaluation?.final_score).toBe(rankedStory.finalScore);
    expect(feedItem).toEqual({
      publication_status: "summary_pending",
      evidence_status: "single_source",
    });
    database.close();
  });

  it("is idempotent for the same evaluation and publication", async () => {
    const { database, version } = await createDocumentVersion();
    const rankedStory = rankStories([
      {
        storyId: "story-1",
        qualityScore: 3,
        personalUtilityScore: 4,
        actionabilityScore: 3,
        triageState: "read_now",
        firstPublicAt: null,
        sourcePublishedAt: null,
      },
    ])[0]!;
    const triageDecision = enforceTriage({
      proposedState: "read_now",
      proposedReason: "High utility and actionable.",
      personalUtilityScore: 4,
      actionabilityScore: 3,
      strategicImplication: null,
      evidenceStatus: "single_source",
      freshnessStatus: "new_development",
      promotionalSignal: false,
      profileMatchSignal: "strong",
      duplicate: false,
      consequential: false,
      finalScore: rankedStory.finalScore,
    });
    const input = {
      documentVersionId: version.id,
      profileVersion: "profile-v1",
      rubricVersion: "rubric-v1",
      promptVersion: "prompt-v1",
      jev: evaluatedJev,
      rankedStory,
      triageDecision,
      freshnessStatus: "new_development" as const,
      freshnessConfidence: "medium" as const,
      evidenceStatus: "single_source" as const,
      sourceCount: 1,
      independentSourceCount: 0,
      createdAt: "2026-10-06T10:02:00Z",
    };

    const first = persistFeedItem(database, input);
    const second = persistFeedItem(database, input);

    expect(second.evaluationId).toBe(first.evaluationId);
    expect(second.triageDecisionId).toBe(first.triageDecisionId);
    expect(second.feedItemId).toBe(first.feedItemId);
    expect(second.evaluationCreated).toBe(false);
    expect(second.triageDecisionCreated).toBe(false);
    expect(second.feedItemCreated).toBe(false);
    database.close();
  });

  it("withdraws older document versions when a newer version is published", async () => {
    const { database, version } = await createDocumentVersion();
    const rankedStory = rankStories([
      {
        storyId: "story-1",
        qualityScore: 3,
        personalUtilityScore: 4,
        actionabilityScore: 3,
        triageState: "read_now",
        firstPublicAt: null,
        sourcePublishedAt: null,
      },
    ])[0]!;
    const triageDecision = enforceTriage({
      proposedState: "read_now",
      proposedReason: "High utility and actionable.",
      personalUtilityScore: 4,
      actionabilityScore: 3,
      strategicImplication: null,
      evidenceStatus: "single_source",
      freshnessStatus: "new_development",
      promotionalSignal: false,
      profileMatchSignal: "strong",
      duplicate: false,
      consequential: false,
      finalScore: rankedStory.finalScore,
    });
    const input = {
      documentVersionId: version.id,
      profileVersion: "profile-v1",
      rubricVersion: "rubric-v1",
      promptVersion: "prompt-v1",
      jev: evaluatedJev,
      rankedStory,
      triageDecision,
      freshnessStatus: "new_development" as const,
      freshnessConfidence: "medium" as const,
      evidenceStatus: "single_source" as const,
      sourceCount: 1,
      independentSourceCount: 0,
      createdAt: "2026-10-06T10:02:00Z",
    };

    const first = persistFeedItem(database, input);
    const newerVersion = createNormalizedDocumentVersion(database, {
      documentId: 1,
      normalizedText: "A newer normalized article with evidence.",
      sourceUpdatedTimestamp: "2026-10-06T11:00:00Z",
      ingestedAt: "2026-10-06T11:01:00Z",
    }).version;
    const second = persistFeedItem(database, {
      ...input,
      documentVersionId: newerVersion.id,
    });

    const statuses = database
      .query<{ id: number; publication_status: string }, []>(
        "SELECT id, publication_status FROM feed_items ORDER BY id",
      )
      .all();
    expect(statuses).toEqual([
      { id: first.feedItemId, publication_status: "withdrawn" },
      { id: second.feedItemId, publication_status: "summary_pending" },
    ]);
    database.close();
  });
});
