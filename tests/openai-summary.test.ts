import { describe, expect, it } from "vitest";
import { OpenAISummaryClient } from "../src/providers/openai-summary";

const request = {
  document: {
    sourceName: "rss",
    sourceItemId: "doc-1",
    title: "Test article",
    author: "Author",
    siteName: "Example",
    sourceUrl: "https://example.com/article",
    category: "article",
    publishedDate: null,
    normalizedText: "Useful article text.",
    contentTruncated: false,
  },
  context: {
    profileVersion: "profile-v1",
    topics: ["ai"],
    namedEntities: [],
    currentDecisions: [],
    exclusions: [],
    editorialBrief: "Prioritize practical analysis.",
  },
  evaluation: {
    primaryTopic: "ai",
    contentType: "analysis",
    qualityScore: 3,
    personalUtilityScore: 4,
    actionabilityScore: 3,
    finalScore: 80,
    triageState: "important_context",
  },
  promptVersion: "summary-v1",
};

describe("OpenAI summary provider", () => {
  it("parses a structured summary response", async () => {
    const client = new OpenAISummaryClient("test-key", {
      model: "gpt-5-nano",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "A concise summary.",
                    whyItMatters: "It informs a current decision.",
                    keyPoints: ["Point one", "Point two", "Point three"],
                    recommendedAction: "Review the implications.",
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 25 },
          }),
          { status: 200 },
        ),
    });

    await expect(client.summarize(request)).resolves.toMatchObject({
      provider: "openai",
      model: "gpt-5-nano",
      summary: "A concise summary.",
      whyItMatters: "It informs a current decision.",
      keyPoints: ["Point one", "Point two", "Point three"],
      recommendedAction: "Review the implications.",
      usage: { inputTokens: 100, outputTokens: 25 },
    });
  });

  it("rejects malformed structured output", async () => {
    const client = new OpenAISummaryClient("test-key", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify({ summary: "Only this" }) },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(client.summarize(request)).rejects.toThrow(
      "whyItMatters must be a non-empty string",
    );
  });

  it("preserves provider errors without exposing credentials", async () => {
    const client = new OpenAISummaryClient("test-key", {
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });

    await expect(client.summarize(request)).rejects.toMatchObject({
      name: "OpenAISummaryApiError",
      status: 401,
    });
  });
});
