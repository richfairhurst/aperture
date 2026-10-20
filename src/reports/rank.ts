import type { ReportEvaluationResult } from "./evaluate";

export type ReportRankingConfig = {
  version: string;
  qualityWeight: number;
  methodologyWeight: number;
  strategicRelevanceWeight: number;
  noveltyWeight: number;
  decisionUtilityWeight: number;
};

export const defaultReportRankingConfig: ReportRankingConfig = {
  version: "report-ranking-v1",
  qualityWeight: 0.25,
  methodologyWeight: 0.2,
  strategicRelevanceWeight: 0.25,
  noveltyWeight: 0.15,
  decisionUtilityWeight: 0.15,
};

export type RankedReport = ReportEvaluationResult & {
  rankingConfigVersion: string;
  finalScore: number;
};

export function rankReports(
  evaluations: readonly ReportEvaluationResult[],
  config: ReportRankingConfig = defaultReportRankingConfig,
): RankedReport[] {
  validateConfig(config);
  return evaluations
    .map((evaluation) => ({
      ...evaluation,
      rankingConfigVersion: config.version,
      finalScore:
        normalize(evaluation.qualityScore) * config.qualityWeight +
        normalize(evaluation.methodologyQualityScore) *
          config.methodologyWeight +
        normalize(evaluation.strategicRelevanceScore) *
          config.strategicRelevanceWeight +
        normalize(evaluation.noveltyScore) * config.noveltyWeight +
        normalize(evaluation.decisionUtilityScore) *
          config.decisionUtilityWeight -
        (evaluation.primarilyPromotional ? 15 : 0),
    }))
    .sort((a, b) => b.finalScore - a.finalScore);
}

function normalize(score: number): number {
  if (!Number.isFinite(score) || score < 0 || score > 4) {
    throw new Error("Report evaluation scores must be numbers from 0 to 4");
  }
  return (score / 4) * 100;
}

function validateConfig(config: ReportRankingConfig): void {
  const weights = [
    config.qualityWeight,
    config.methodologyWeight,
    config.strategicRelevanceWeight,
    config.noveltyWeight,
    config.decisionUtilityWeight,
  ];
  if (
    !config.version.trim() ||
    weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
    Math.abs(weights.reduce((total, weight) => total + weight, 0) - 1) >
      0.000001
  ) {
    throw new Error("Report ranking weights must be non-negative and sum to 1");
  }
}
