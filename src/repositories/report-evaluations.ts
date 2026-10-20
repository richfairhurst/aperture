import type { Database } from "bun:sqlite";
import type { ReportEvaluationResult } from "../reports/evaluate";
import {
  defaultReportRankingConfig,
  rankReports,
  type ReportRankingConfig,
} from "../reports/rank";

export function persistReportEvaluation(
  database: Database,
  reportVersionId: number,
  evaluation: ReportEvaluationResult,
  rankingConfig: ReportRankingConfig = defaultReportRankingConfig,
): number {
  const ranked = rankReports([evaluation], rankingConfig)[0];
  if (!ranked) throw new Error("Report evaluation could not be ranked");
  database
    .query(
      `INSERT INTO report_evaluations (
        report_version_id, rubric_version, prompt_version, ranking_config_version,
        report_type, primary_topic, activity_status, quality_score,
        methodology_quality_score, strategic_relevance_score, novelty_score,
        decision_utility_score, contains_evidence, primarily_promotional,
        final_score, raw_response_json, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (report_version_id, rubric_version, prompt_version, ranking_config_version)
      DO UPDATE SET final_score = excluded.final_score,
        raw_response_json = excluded.raw_response_json,
        evaluated_at = excluded.evaluated_at`,
    )
    .run(
      reportVersionId,
      evaluation.rubricVersion,
      evaluation.promptVersion,
      rankingConfig.version,
      evaluation.reportType,
      evaluation.primaryTopic,
      evaluation.activityStatus,
      evaluation.qualityScore,
      evaluation.methodologyQualityScore,
      evaluation.strategicRelevanceScore,
      evaluation.noveltyScore,
      evaluation.decisionUtilityScore,
      evaluation.containsEvidence ? 1 : 0,
      evaluation.primarilyPromotional ? 1 : 0,
      ranked.finalScore,
      JSON.stringify(evaluation.rawResponse),
      evaluation.evaluatedAt,
    );
  const row = database
    .query<{ id: number }, [number, string, string, string]>(
      `SELECT id FROM report_evaluations
       WHERE report_version_id = ? AND rubric_version = ? AND prompt_version = ?
         AND ranking_config_version = ?`,
    )
    .get(
      reportVersionId,
      evaluation.rubricVersion,
      evaluation.promptVersion,
      rankingConfig.version,
    );
  if (!row) throw new Error("Report evaluation was not found after insert");
  return row.id;
}
