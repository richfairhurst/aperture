import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import {
  processMediastackDocuments,
  processReadwiseDocuments,
  processYouTubeDocuments,
} from "../src/pipeline/evaluate";
import { JevClient } from "../src/providers/jev";
import type { ReadwiseDocument } from "../src/providers/readwise";
import type { SummaryProvider } from "../src/contracts/providers";
import type { YouTubeVideo } from "../src/providers/youtube";
import type { YouTubeTranscript } from "../src/providers/youtube-transcript";
import type { MediastackArticle } from "../src/providers/mediastack";

const validJevResponse = {
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
    has_mental_model: { type: "noul", noul: 0 },
    has_relevant_action: { type: "noul", noul: 1 },
    worth_sharing_executive: { type: "noul", noul: 1 },
    primarily_promotional: { type: "noul", noul: 0 },
  },
  usage: { input_tokens: 100, output_tokens: 50 },
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
  };
}

function document(id: string, htmlContent: string | null): ReadwiseDocument {
  return {
    id,
    url: `https://example.com/${id}`,
    sourceUrl: `https://example.com/${id}`,
    title: `Document ${id}`,
    author: null,
    htmlContent,
    category: "article",
    createdAt: "2026-10-06T11:00:00Z",
    updatedAt: "2026-10-06T11:00:00Z",
    publishedDate: "2026-10-06T10:00:00Z",
    savedAt: null,
    siteName: "Example",
    readwiseUrl: `https://readwise.io/read/${id}`,
    imageUrl: null,
  };
}

function createJevClient(callCounter: { count: number }): JevClient {
  return new JevClient("test-key", {
    fetchImpl: async () => {
      callCounter.count += 1;
      return new Response(JSON.stringify(validJevResponse), {
        headers: { "content-type": "application/json" },
      });
    },
  });
}

function createSummaryProvider(callCounter: {
  count: number;
}): SummaryProvider {
  return {
    summarize: async (request) => {
      callCounter.count += 1;
      return {
        provider: "test",
        model: "test-summary",
        promptVersion: request.promptVersion,
        summary: "A concise summary.",
        whyItMatters: "It is relevant context.",
        keyPoints: ["One", "Two", "Three"],
        recommendedAction: null,
        rawResponse: { fixture: true },
        usage: null,
        generatedAt: "2026-10-06T12:00:00Z",
      };
    },
  };
}

describe("evaluation pipeline", () => {
  it("normalizes and publishes a Mediastack article idempotently", async () => {
    const database = await openDatabase(":memory:");
    const article: MediastackArticle = {
      id: "https://example.com/news|2026-10-06T10:00:00Z",
      keyword: "China",
      title: "A useful news report",
      source: "Example News",
      url: "https://example.com/news",
      description: "A useful description for evaluation.",
      publishedAt: "2026-10-06T10:00:00Z",
      author: "Reporter",
      imageUrl: null,
      language: "en",
      country: "gb",
      category: "general",
    };
    const options = {
      context: {
        profileVersion: "profile-v1",
        topics: ["ai"],
        namedEntities: [],
        currentDecisions: [],
        exclusions: [],
        editorialBrief: "Prioritize useful analysis.",
      },
      rubricVersion: "rubric-v1",
      promptVersion: "prompt-v1",
      now: new Date("2026-10-06T12:00:00Z"),
    };
    const client = createJevClient({ count: 0 });

    const first = await processMediastackDocuments(
      database,
      [article],
      client,
      options,
    );
    const second = await processMediastackDocuments(
      database,
      [article],
      client,
      options,
    );

    expect(first.feedItemsCreated).toBe(1);
    expect(second.feedItemsCreated).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM documents WHERE source_name = 'mediastack'",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM mediastack_document_keywords",
        )
        .get()?.count,
    ).toBe(1);
    database.close();
  });

  it("processes a YouTube transcript through scoring, triage, and feed publication", async () => {
    const database = await openDatabase(":memory:");
    const video: YouTubeVideo = {
      id: "video-1",
      title: "A useful YouTube analysis",
      description: "Description",
      channelId: "UC-channel",
      channelTitle: "Test channel",
      sourceUrl: "https://www.youtube.com/watch?v=video-1",
      publishedAt: "2026-10-06T10:00:00Z",
      durationSeconds: 120,
      thumbnailUrl: null,
    };
    const transcript: YouTubeTranscript = {
      videoId: video.id,
      language: "en",
      status: "available",
      content: { text: "A useful transcript.", wordCount: 3 },
      reason: null,
    };
    const transcriptCalls = { count: 0 };
    const transcriptClient = {
      retrieve: async () => {
        transcriptCalls.count += 1;
        return transcript;
      },
    };

    const result = await processYouTubeDocuments(
      database,
      [video],
      transcriptClient,
      createJevClient({ count: 0 }),
      {
        context: {
          profileVersion: "profile-v1",
          topics: ["ai"],
          namedEntities: [],
          currentDecisions: [],
          exclusions: [],
          editorialBrief: "Prioritize useful analysis.",
        },
        rubricVersion: "rubric-v1",
        promptVersion: "prompt-v1",
        now: new Date("2026-10-06T12:00:00Z"),
      },
    );

    expect(result.itemsProcessed).toBe(1);
    expect(result.evaluationsCreated).toBe(1);
    expect(result.feedItemsCreated).toBe(1);

    const repeat = await processYouTubeDocuments(
      database,
      [video],
      transcriptClient,
      createJevClient({ count: 0 }),
      {
        context: {
          profileVersion: "profile-v1",
          topics: ["ai"],
          namedEntities: [],
          currentDecisions: [],
          exclusions: [],
          editorialBrief: "Prioritize useful analysis.",
        },
        rubricVersion: "rubric-v1",
        promptVersion: "prompt-v1",
        now: new Date("2026-10-06T12:00:00Z"),
      },
    );
    expect(repeat.itemsProcessed).toBe(0);
    expect(transcriptCalls.count).toBe(1);

    const persisted = database
      .query<
        { source_name: string; source_item_id: string; content_hash: string },
        []
      >(
        `SELECT d.source_name, d.source_item_id, v.content_hash
         FROM documents d JOIN document_versions v ON v.document_id = d.id
         WHERE d.source_name = 'youtube'`,
      )
      .get();
    expect(persisted?.source_item_id).toBe("video-1");
    expect(persisted?.content_hash).toBeTruthy();
    expect(
      database
        .query<{ primary_topic: string; publication_status: string }, []>(
          `SELECT e.primary_topic, f.publication_status
           FROM feed_items f JOIN evaluations e ON e.id = f.evaluation_id`,
        )
        .get(),
    ).toEqual({ primary_topic: "ai", publication_status: "summary_pending" });
    database.close();
  });

  it("normalizes, evaluates, ranks, triages, and publishes a document", async () => {
    const database = await openDatabase(":memory:");
    const calls = { count: 0 };
    const result = await processReadwiseDocuments(
      database,
      [document("doc-1", "<p>Useful article content.</p>")],
      createJevClient(calls),
      {
        context: {
          profileVersion: "profile-v1",
          topics: ["ai"],
          namedEntities: [],
          currentDecisions: [],
          exclusions: [],
          editorialBrief: "Prioritize useful analysis.",
        },
        rubricVersion: "rubric-v1",
        promptVersion: "prompt-v1",
        now: new Date("2026-10-06T12:00:00Z"),
      },
    );

    expect(result.itemsProcessed).toBe(1);
    expect(result.itemsFailed).toBe(0);
    expect(result.evaluationsCreated).toBe(1);
    expect(result.feedItemsCreated).toBe(1);
    expect(calls.count).toBe(1);

    const feed = database
      .query<{ triage_state: string; publication_status: string }, []>(
        "SELECT triage_state, publication_status FROM feed_items",
      )
      .get();
    expect(feed).toEqual({
      triage_state: "watch",
      publication_status: "summary_pending",
    });
    database.close();
  });

  it("does not call Jev or duplicate records on repeat processing", async () => {
    const database = await openDatabase(":memory:");
    const calls = { count: 0 };
    const client = createJevClient(calls);
    const options = {
      context: {
        profileVersion: "profile-v1",
        topics: ["ai"],
        namedEntities: [],
        currentDecisions: [],
        exclusions: [],
        editorialBrief: "Prioritize useful analysis.",
      },
      rubricVersion: "rubric-v1",
      promptVersion: "prompt-v1",
      now: new Date("2026-10-06T12:00:00Z"),
    };
    const input = [document("doc-1", "<p>Useful article content.</p>")];

    const first = await processReadwiseDocuments(
      database,
      input,
      client,
      options,
    );
    const second = await processReadwiseDocuments(
      database,
      input,
      client,
      options,
    );

    expect(first.evaluationsCreated).toBe(1);
    expect(second.itemsProcessed).toBe(1);
    expect(second.evaluationsCreated).toBe(0);
    expect(second.feedItemsCreated).toBe(0);
    expect(calls.count).toBe(1);
    database.close();
  });

  it("isolates empty-content skips from valid documents", async () => {
    const database = await openDatabase(":memory:");
    const result = await processReadwiseDocuments(
      database,
      [document("empty", null), document("valid", "<p>Valid text.</p>")],
      createJevClient({ count: 0 }),
      {
        context: {
          profileVersion: "profile-v1",
          topics: ["ai"],
          namedEntities: [],
          currentDecisions: [],
          exclusions: [],
          editorialBrief: "Prioritize useful analysis.",
        },
        rubricVersion: "rubric-v1",
        promptVersion: "prompt-v1",
        now: new Date("2026-10-06T12:00:00Z"),
      },
    );

    expect(result.itemsSkipped).toBe(1);
    expect(result.itemsProcessed).toBe(1);
    expect(result.skipped[0]?.reason).toContain("usable text");
    database.close();
  });

  it("caps summary work and reports completed background-stage results", async () => {
    const database = await openDatabase(":memory:");
    const jevCalls = { count: 0 };
    const summaryCalls = { count: 0 };
    const result = await processReadwiseDocuments(
      database,
      [
        document("one", "<p>First valid text.</p>"),
        document("two", "<p>Second valid text.</p>"),
        document("three", "<p>Third valid text.</p>"),
      ],
      createJevClient(jevCalls),
      {
        context: {
          profileVersion: "profile-v1",
          topics: ["ai"],
          namedEntities: [],
          currentDecisions: [],
          exclusions: [],
          editorialBrief: "Prioritize useful analysis.",
        },
        rubricVersion: "rubric-v1",
        promptVersion: "prompt-v1",
        summaryPromptVersion: "summary-v2",
        summaryProvider: createSummaryProvider(summaryCalls),
        summaryMaxPerRun: 2,
        summaryConcurrency: 2,
        now: new Date("2026-10-06T12:00:00Z"),
      },
    );

    expect(result.itemsProcessed).toBe(3);
    expect(result.summariesScheduled).toBe(2);
    expect(result.summariesAttempted).toBe(2);
    expect(result.summariesCompleted).toBe(2);
    expect(result.summariesFailed).toBe(0);
    expect(summaryCalls.count).toBe(2);
    expect(jevCalls.count).toBe(3);
    database.close();
  });
});
