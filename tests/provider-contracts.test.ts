import { describe, expect, it } from "vitest";
import {
  evaluateDocument,
  summarizeDocument,
  type EvaluationProvider,
  type EvaluationRequest,
  type EvaluationResult,
  type ProviderDocument,
  type SummaryProvider,
  type SummaryRequest,
  type SummaryResult,
} from "../src/contracts/providers";

const providerDocument: ProviderDocument = {
  sourceName: "rss",
  sourceItemId: "doc-1",
  title: "Example document",
  author: "Example author",
  siteName: "Example site",
  sourceUrl: "https://example.com/article",
  category: "article",
  publishedDate: null,
  normalizedText: "Example normalized document text.",
  contentTruncated: false,
};

const evaluationRequest: EvaluationRequest = {
  document: providerDocument,
  context: {
    profileVersion: "profile-v1",
    topics: ["ai"],
    namedEntities: [],
    currentDecisions: [],
    exclusions: [],
    editorialBrief: "Prioritize practical, decision-relevant analysis.",
  },
  rubricVersion: "rubric-v1",
  promptVersion: "prompt-v1",
};

const evaluationResult: EvaluationResult = {
  provider: "fake-jev",
  model: "fake-model",
  rubricVersion: "rubric-v1",
  profileVersion: "profile-v1",
  promptVersion: "prompt-v1",
  primaryTopic: "ai",
  contentType: "analysis",
  qualityScore: 3,
  personalUtilityScore: 4,
  actionabilityScore: 3,
  noulResults: { evidence: 4 },
  probabilities: { primaryTopic: { ai: 0.9 } },
  confidence: { primaryTopic: 0.9 },
  strategicImplication: "Review the implementation pattern.",
  rawResponse: { fixture: true },
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  evaluatedAt: "2026-10-06T12:00:00Z",
};

const summaryRequest: SummaryRequest = {
  document: providerDocument,
  context: evaluationRequest.context,
  evaluation: evaluationResult,
  promptVersion: "summary-prompt-v1",
};

const summaryResult: SummaryResult = {
  provider: "fake-summary",
  model: "fake-model",
  promptVersion: "summary-prompt-v1",
  summary: "A short summary.",
  whyItMatters: "It is relevant to the current focus.",
  keyPoints: ["One key point."],
  recommendedAction: "Review the source.",
  rawResponse: { fixture: true },
  usage: { totalTokens: 75 },
  generatedAt: "2026-10-06T12:00:00Z",
};

class FakeEvaluationProvider implements EvaluationProvider {
  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    expect(request.document.sourceItemId).toBe("doc-1");
    return evaluationResult;
  }
}

class FakeSummaryProvider implements SummaryProvider {
  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    expect(request.evaluation.personalUtilityScore).toBe(4);
    return summaryResult;
  }
}

describe("provider contracts", () => {
  it("supports a fake evaluation provider without HTTP details", async () => {
    const result = await evaluateDocument(
      new FakeEvaluationProvider(),
      evaluationRequest,
    );

    expect(result.provider).toBe("fake-jev");
    expect(result.qualityScore).toBe(3);
  });

  it("supports a fake summary provider without HTTP details", async () => {
    const result = await summarizeDocument(
      new FakeSummaryProvider(),
      summaryRequest,
    );

    expect(result.provider).toBe("fake-summary");
    expect(result.keyPoints).toEqual(["One key point."]);
  });
});
