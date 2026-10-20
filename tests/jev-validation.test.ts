import { describe, expect, it } from "vitest";
import {
  JevValidationError,
  defaultJevQuestionSchema,
  validateJevResponse,
} from "../src/validation/jev";

function validResponse(): Record<string, unknown> {
  return {
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
        confidence: 0.8,
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
      quality_score: scoreAnswer(3),
      personal_utility_score: scoreAnswer(4),
      actionability_score: scoreAnswer(3),
      contains_evidence: { type: "noul", noul: 1 },
      has_mental_model: { type: "noul", noul: 0 },
      has_relevant_action: { type: "noul", noul: 1 },
      worth_sharing_executive: { type: "noul", noul: 1 },
      primarily_promotional: { type: "noul", noul: 0 },
    },
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function scoreAnswer(score: number): Record<string, unknown> {
  return {
    type: "score",
    score,
    confidence: 0.8,
    probabilities: {
      "0": score === 0 ? 1 : 0,
      "1": score === 1 ? 1 : 0,
      "2": score === 2 ? 1 : 0,
      "3": score === 3 ? 1 : 0,
      "4": score === 4 ? 1 : 0,
    },
    legend: {
      "0": "low",
      "1": "limited",
      "2": "useful",
      "3": "strong",
      "4": "exceptional",
    },
  };
}

describe("Jev response validation", () => {
  it("validates choice, score, Noul, probabilities, confidence, and usage", () => {
    const result = validateJevResponse(validResponse());

    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.primary_topic).toMatchObject({
      type: "choice",
      choice: "ai",
    });
    expect(result.answers.quality_score).toMatchObject({
      type: "score",
      score: 3,
    });
    expect(result.answers.contains_evidence).toEqual({ type: "noul", noul: 1 });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("allows Noul answers without probability or confidence", () => {
    const payload = validResponse();
    const answers = payload.answers as Record<string, Record<string, unknown>>;
    answers.contains_evidence = { type: "noul", noul: 0.75 };

    expect(validateJevResponse(payload).answers.contains_evidence).toEqual({
      type: "noul",
      noul: 0.75,
    });
  });

  it("allows fractional scores within the configured range", () => {
    const payload = validResponse();
    const answers = payload.answers as Record<string, Record<string, unknown>>;
    answers.quality_score!.score = 3.5;

    expect(validateJevResponse(payload).answers.quality_score).toMatchObject({
      type: "score",
      score: 3.5,
    });
  });

  it("rejects missing and unexpected questions", () => {
    const missing = validResponse();
    delete (missing.answers as Record<string, unknown>).content_type;
    expect(() => validateJevResponse(missing)).toThrowError(JevValidationError);

    const unexpected = validResponse();
    (unexpected.answers as Record<string, unknown>).extra = {
      type: "noul",
      noul: 1,
    };
    expect(() => validateJevResponse(unexpected)).toThrowError(
      JevValidationError,
    );
  });

  it("rejects invalid choices, score ranges, confidence, and distributions", () => {
    const invalidChoice = validResponse();
    const choiceAnswers = invalidChoice.answers as Record<
      string,
      Record<string, unknown>
    >;
    choiceAnswers.primary_topic!.choice = "unknown";
    expect(() => validateJevResponse(invalidChoice)).toThrowError(
      JevValidationError,
    );

    const invalidScore = validResponse();
    const scoreAnswers = invalidScore.answers as Record<
      string,
      Record<string, unknown>
    >;
    scoreAnswers.quality_score!.score = 5;
    expect(() => validateJevResponse(invalidScore)).toThrowError(
      JevValidationError,
    );

    const invalidDistribution = validResponse();
    const distributionAnswers = invalidDistribution.answers as Record<
      string,
      Record<string, unknown>
    >;
    const probabilities = distributionAnswers.primary_topic!
      .probabilities as Record<string, number>;
    probabilities.ai = 0.5;
    expect(() => validateJevResponse(invalidDistribution)).toThrowError(
      JevValidationError,
    );
  });

  it("validates against a custom schema", () => {
    const result = validateJevResponse(
      {
        model: "jev-test",
        answers: {
          label: {
            type: "choice",
            choice: "yes",
            confidence: 1,
            probabilities: { yes: 1, no: 0 },
          },
        },
      },
      { label: { type: "choice", choices: ["yes", "no"] } },
    );

    expect(result.answers.label).toMatchObject({ choice: "yes" });
    expect(Object.keys(defaultJevQuestionSchema)).toHaveLength(10);
  });
});
