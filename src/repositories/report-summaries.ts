import type { Database } from "bun:sqlite";
import type { ReportSummaryResult } from "../reports/summary";

export function persistReportSummary(
  database: Database,
  reportVersionId: number,
  result: ReportSummaryResult,
): number {
  database
    .query(
      `INSERT INTO report_summaries (
        report_version_id, provider, model, prompt_version, read_verdict,
        summary, one_sentence_summary, key_takeaways_json,
        important_findings_json, deep_insights_json, mental_models_json,
        practical_implications_json, recommendations_json,
        methodology_limitations, activity_context, quotes_json, references_json,
        raw_response_json, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (report_version_id, prompt_version) DO UPDATE SET
        read_verdict = excluded.read_verdict,
        summary = excluded.summary,
        one_sentence_summary = excluded.one_sentence_summary,
        key_takeaways_json = excluded.key_takeaways_json,
        important_findings_json = excluded.important_findings_json,
        deep_insights_json = excluded.deep_insights_json,
        mental_models_json = excluded.mental_models_json,
        practical_implications_json = excluded.practical_implications_json,
        recommendations_json = excluded.recommendations_json,
        methodology_limitations = excluded.methodology_limitations,
        activity_context = excluded.activity_context,
        quotes_json = excluded.quotes_json,
        references_json = excluded.references_json,
        raw_response_json = excluded.raw_response_json,
        generated_at = excluded.generated_at`,
    )
    .run(
      reportVersionId,
      result.provider,
      result.model,
      result.promptVersion,
      result.readVerdict,
      result.summary,
      result.oneSentenceSummary,
      JSON.stringify(result.keyTakeaways),
      JSON.stringify(result.importantFindings),
      JSON.stringify(result.deepInsights),
      JSON.stringify(result.mentalModels),
      JSON.stringify(result.practicalImplications),
      JSON.stringify(result.recommendations),
      result.methodologyAndLimitations,
      result.activityContext,
      JSON.stringify(result.quotes),
      JSON.stringify(result.references),
      JSON.stringify(result.rawResponse),
      result.generatedAt,
    );
  const row = database
    .query<{ id: number }, [number, string]>(
      "SELECT id FROM report_summaries WHERE report_version_id = ? AND prompt_version = ?",
    )
    .get(reportVersionId, result.promptVersion);
  if (!row) throw new Error("Report summary was not found after insert");
  return row.id;
}
