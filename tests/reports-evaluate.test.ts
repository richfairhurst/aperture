import { describe, expect, it } from "vitest";
import { JevClient } from "../src/providers/jev";
import {
  evaluateReport,
  reportJevQuestionSchema,
  reportPromptVersion,
  reportRubricVersion,
} from "../src/reports/evaluate";
import { rankReports } from "../src/reports/rank";

function score(value: number) {
  return {
    type: "score" as const,
    score: value,
    confidence: 0.9,
    probabilities: {
      "0": 0,
      "1": 0,
      "2": 0,
      "3": 0,
      "4": 0,
      [String(value)]: 1,
    },
  };
}

function response() {
  return {
    model: "jev-report-test",
    answers: {
      report_type: {
        type: "choice",
        choice: "threat_intelligence",
        confidence: 0.9,
        probabilities: {
          threat_intelligence: 1,
          annual_analysis: 0,
          survey: 0,
          research: 0,
          other: 0,
        },
      },
      primary_topic: {
        type: "choice",
        choice: "cybersecurity",
        confidence: 0.9,
        probabilities: {
          ai: 0,
          cybersecurity: 1,
          geopolitics: 0,
          technology_strategy: 0,
          executive_decision_making: 0,
          business_opportunity: 0,
          other: 0,
        },
      },
      quality_score: score(4),
      methodology_quality: score(4),
      strategic_relevance: score(3),
      novelty: score(3),
      decision_utility: score(4),
      activity_status: {
        type: "choice",
        choice: "historical_activity",
        confidence: 0.9,
        probabilities: {
          new_activity: 0,
          historical_activity: 1,
          mixed_or_unclear: 0,
        },
      },
      contains_evidence: { type: "noul", noul: 1 },
      primarily_promotional: { type: "noul", noul: 0 },
    },
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

describe("report evaluation and ranking", () => {
  it("uses a separate report rubric and prompt with temporal instructions", async () => {
    const captured: {
      current: { questions: unknown; state: string } | null;
    } = { current: null };
    const client = new JevClient("test-key", {
      fetchImpl: async (_input, init) => {
        captured.current = JSON.parse(String(init?.body)) as {
          questions: unknown;
          state: string;
        };
        return new Response(JSON.stringify(response()));
      },
    });
    const result = await evaluateReport(
      client,
      {
        sourceName: "report",
        sourceItemId: "report-1",
        title: "Threat report",
        author: null,
        siteName: "ROSTI",
        sourceUrl: "https://example.com/report",
        category: "report",
        publishedDate: "2026-10-14T00:00:00Z",
        normalizedText: "Evidence and methodology",
        contentTruncated: false,
      },
      {
        profileVersion: "profile-v1",
        topics: ["cybersecurity"],
        namedEntities: [],
        currentDecisions: [],
        exclusions: [],
        editorialBrief: "Prioritize evidence.",
      },
    );
    expect(result.rubricVersion).toBe(reportRubricVersion);
    expect(result.promptVersion).toBe(reportPromptVersion);
    expect(result.activityStatus).toBe("historical_activity");
    expect(captured.current?.state).toContain(
      "Never infer new underlying activity",
    );
    expect(Object.keys(captured.current?.questions ?? {})).toEqual(
      Object.keys(reportJevQuestionSchema),
    );
  });

  it("penalizes promotional roundups and rewards rigorous reports", () => {
    const base = {
      provider: "jev",
      model: "test",
      rubricVersion: reportRubricVersion,
      promptVersion: reportPromptVersion,
      reportType: "survey",
      primaryTopic: "cybersecurity",
      activityStatus: "mixed_or_unclear",
      containsEvidence: true,
      rawResponse: {},
      evaluatedAt: "2026-10-14T00:00:00Z",
    };
    const ranked = rankReports([
      {
        ...base,
        reportType: "research",
        activityStatus: "new_activity",
        qualityScore: 4,
        methodologyQualityScore: 4,
        strategicRelevanceScore: 4,
        noveltyScore: 3,
        decisionUtilityScore: 4,
        primarilyPromotional: false,
      },
      {
        ...base,
        qualityScore: 4,
        methodologyQualityScore: 1,
        strategicRelevanceScore: 3,
        noveltyScore: 1,
        decisionUtilityScore: 2,
        primarilyPromotional: true,
      },
      {
        ...base,
        reportType: "annual_analysis",
        activityStatus: "mixed_or_unclear",
        qualityScore: 3,
        methodologyQualityScore: 3,
        strategicRelevanceScore: 3,
        noveltyScore: 2,
        decisionUtilityScore: 3,
        primarilyPromotional: false,
      },
      {
        ...base,
        reportType: "threat_intelligence",
        activityStatus: "historical_activity",
        qualityScore: 3,
        methodologyQualityScore: 4,
        strategicRelevanceScore: 4,
        noveltyScore: 2,
        decisionUtilityScore: 3,
        primarilyPromotional: false,
      },
    ]);
    expect(ranked).toHaveLength(4);
    expect(ranked[0]?.primarilyPromotional).toBe(false);
    expect(ranked[0]?.finalScore).toBeGreaterThan(ranked[1]?.finalScore ?? 0);
  });
});
