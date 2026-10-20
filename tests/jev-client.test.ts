import { describe, expect, it } from "vitest";
import {
  JevApiError,
  JevClient,
  JevResponseError,
  JevTimeoutError,
  buildJevState,
} from "../src/providers/jev";
import type { EvaluationRequest } from "../src/contracts/providers";

const request: EvaluationRequest = {
  document: {
    sourceName: "rss",
    sourceItemId: "doc-1",
    title: "Example document",
    author: "Example author",
    siteName: "Example site",
    sourceUrl: "https://example.com/article",
    category: "article",
    publishedDate: null,
    normalizedText: "A normalized document with evidence.",
    contentTruncated: false,
  },
  context: {
    profileVersion: "profile-v1",
    topics: ["ai"],
    namedEntities: [],
    currentDecisions: [],
    exclusions: [],
    editorialBrief: "Prioritize practical decision-relevant analysis.",
  },
  rubricVersion: "rubric-v1",
  promptVersion: "prompt-v1",
};

function validResponse(): Record<string, unknown> {
  const choice = (answer: string, choices: string[]) => ({
    type: "choice",
    choice: answer,
    confidence: 0.9,
    probabilities: Object.fromEntries(
      choices.map((value) => [value, value === answer ? 1 : 0]),
    ),
  });
  const score = (value: number) => ({
    type: "score",
    score: value,
    confidence: 0.8,
    probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, [value]: 1 },
  });

  return {
    model: "jev-1.13.0",
    answers: {
      primary_topic: choice("ai", [
        "ai",
        "cybersecurity",
        "geopolitics",
        "technology_strategy",
        "executive_decision_making",
        "business_opportunity",
        "other",
      ]),
      content_type: choice("analysis", [
        "analysis",
        "news",
        "research",
        "opinion",
        "how_to",
        "interview",
        "announcement",
        "other",
      ]),
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
}

describe("Jev client", () => {
  it("builds a server-side request and returns validated output", async () => {
    let requestBody: unknown;
    const client = new JevClient("test-key", {
      model: "jev-test",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(validResponse()), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await client.evaluate(request);
    const body = requestBody as Record<string, unknown>;
    const questions = body.questions as Record<string, unknown>;

    expect(result.model).toBe("jev-1.13.0");
    expect(Object.keys(result.answers)).toHaveLength(10);
    expect(body.model).toBe("jev-test");
    expect(questions.primary_topic).toBeDefined();
    expect(String(body.state)).toContain(
      "A normalized document with evidence.",
    );
    expect(String(body.state)).toContain("Scoring calibration:");
    expect(String(body.state)).toContain("routine digest or recurring roundup");
  });

  it("sends authentication without exposing it in failures", async () => {
    let authorization: string | null = null;
    const client = new JevClient("secret-key", {
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "10" },
        });
      },
    });

    await expect(client.evaluate(request)).rejects.toMatchObject({
      status: 429,
      retryable: true,
      retryAfter: "10",
    });
    expect(authorization).toBe("Bearer secret-key");
    await expect(client.evaluate(request)).rejects.not.toThrow("secret-key");
  });

  it("classifies malformed provider output", async () => {
    const client = new JevClient("test-key", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ model: "jev-test", answers: {} })),
    });

    await expect(client.evaluate(request)).rejects.toBeInstanceOf(
      JevResponseError,
    );
  });

  it("classifies timeout failures", async () => {
    const client = new JevClient("test-key", {
      timeoutMs: 1,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    });

    await expect(client.evaluate(request)).rejects.toBeInstanceOf(
      JevTimeoutError,
    );
  });

  it("does not leak document state into API errors", async () => {
    const client = new JevClient("test-key", {
      fetchImpl: async () => new Response("bad", { status: 400 }),
    });

    await expect(client.evaluate(request)).rejects.toBeInstanceOf(JevApiError);
    await expect(client.evaluate(request)).rejects.not.toThrow(
      "normalized document",
    );
    expect(buildJevState(request)).toContain("normalized document");
  });
});
