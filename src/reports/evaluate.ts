import type {
  IntelligenceContext,
  ProviderDocument,
} from "../contracts/providers";
import { JevClient } from "../providers/jev";
import type { JevQuestionDefinitions } from "../providers/jev";
import type { JevQuestionSchema } from "../validation/jev";
import type { ValidatedJevResponse } from "../validation/jev";

export const reportRubricVersion = "report-rubric-v1";
export const reportPromptVersion = "report-prompt-v1";

export const reportJevQuestions: JevQuestionDefinitions = {
  report_type: {
    type: "choice",
    instructions: "What kind of report is this?",
    criteria: {
      threat_intelligence: "Threat intelligence or incident reporting",
      annual_analysis: "Annual analysis or recurring industry outlook",
      survey: "Survey or benchmark study",
      research: "Research paper or original research",
      other: "Other report type",
    },
  },
  primary_topic: {
    type: "choice",
    instructions: "Which primary topic best fits this report?",
    criteria: {
      ai: "Artificial intelligence, models, governance, or applications",
      cybersecurity: "Security, cyber risk, threats, resilience, or privacy",
      geopolitics: "Geopolitics, national security, defense, or intelligence",
      technology_strategy: "Technology adoption, platforms, or transformation",
      executive_decision_making:
        "Leadership, governance, or operating decisions",
      business_opportunity:
        "Commercial, advisory, investment, or career relevance",
      other: "Does not fit the focus areas",
    },
  },
  quality_score: scoreQuestion(
    "How strong is the report overall? Reward evidence, substance, and useful original analysis. Penalize marketing roundups and unsupported claims.",
  ),
  methodology_quality: scoreQuestion(
    "How rigorous and transparent are the methodology, evidence, and data provenance?",
  ),
  strategic_relevance: scoreQuestion(
    "How strategically relevant is this report to AI, cyber risk, geopolitics, or executive decision-making?",
  ),
  novelty: scoreQuestion(
    "How much genuinely new information, quantified finding, or longitudinal insight does this report add? Do not reward a recent index date alone.",
  ),
  decision_utility: scoreQuestion(
    "How useful is this report for a concrete decision, research direction, writing project, or executive conversation?",
  ),
  activity_status: {
    type: "choice",
    instructions:
      "What does the report say about the timing of the underlying activity?",
    criteria: {
      new_activity: "Describes recent or ongoing activity",
      historical_activity: "New reporting about activity that already occurred",
      mixed_or_unclear: "Mixed, forecast, or unclear timing",
    },
  },
  contains_evidence: {
    type: "noul",
    instructions:
      "Does the report contain concrete evidence or quantified findings?",
  },
  primarily_promotional: {
    type: "noul",
    instructions:
      "Is the report primarily promotional, vendor marketing, or low-signal content?",
  },
};

export const reportJevQuestionSchema: JevQuestionSchema = {
  report_type: {
    type: "choice",
    choices: [
      "threat_intelligence",
      "annual_analysis",
      "survey",
      "research",
      "other",
    ],
  },
  primary_topic: {
    type: "choice",
    choices: [
      "ai",
      "cybersecurity",
      "geopolitics",
      "technology_strategy",
      "executive_decision_making",
      "business_opportunity",
      "other",
    ],
  },
  quality_score: { type: "score", minimum: 0, maximum: 4 },
  methodology_quality: { type: "score", minimum: 0, maximum: 4 },
  strategic_relevance: { type: "score", minimum: 0, maximum: 4 },
  novelty: { type: "score", minimum: 0, maximum: 4 },
  decision_utility: { type: "score", minimum: 0, maximum: 4 },
  activity_status: {
    type: "choice",
    choices: ["new_activity", "historical_activity", "mixed_or_unclear"],
  },
  contains_evidence: { type: "noul" },
  primarily_promotional: { type: "noul" },
};

export type ReportEvaluationResult = {
  provider: string;
  model: string;
  rubricVersion: string;
  promptVersion: string;
  reportType: string;
  primaryTopic: string;
  activityStatus: string;
  qualityScore: number;
  methodologyQualityScore: number;
  strategicRelevanceScore: number;
  noveltyScore: number;
  decisionUtilityScore: number;
  containsEvidence: boolean;
  primarilyPromotional: boolean;
  rawResponse: unknown;
  evaluatedAt: string;
};

export async function evaluateReport(
  client: JevClient,
  document: ProviderDocument,
  context: IntelligenceContext,
): Promise<ReportEvaluationResult> {
  const response = await client.evaluate({
    document: { ...document, category: "report" },
    context,
    rubricVersion: reportRubricVersion,
    promptVersion: reportPromptVersion,
    questionDefinitions: reportJevQuestions,
    questionSchema: reportJevQuestionSchema,
    promptInstructions:
      "Evaluate this as a report, not a news article. Distinguish report publication/index date from the period studied. Reward methodology, primary-source evidence, quantified findings, longitudinal comparison, and decision utility. Penalize promotional annual roundups. Never infer new underlying activity from a recent publication or index date.",
  });
  return mapReportEvaluation(response);
}

function mapReportEvaluation(
  response: ValidatedJevResponse,
): ReportEvaluationResult {
  const choice = (key: string): string => {
    const answer = response.answers[key];
    return answer?.type === "choice" ? answer.choice : "other";
  };
  const score = (key: string): number => {
    const answer = response.answers[key];
    return answer?.type === "score" ? answer.score : 0;
  };
  const noul = (key: string): boolean => {
    const answer = response.answers[key];
    return answer?.type === "noul" && answer.noul >= 0.5;
  };
  return {
    provider: "jev",
    model: response.model,
    rubricVersion: reportRubricVersion,
    promptVersion: reportPromptVersion,
    reportType: choice("report_type"),
    primaryTopic: choice("primary_topic"),
    activityStatus: choice("activity_status"),
    qualityScore: score("quality_score"),
    methodologyQualityScore: score("methodology_quality"),
    strategicRelevanceScore: score("strategic_relevance"),
    noveltyScore: score("novelty"),
    decisionUtilityScore: score("decision_utility"),
    containsEvidence: noul("contains_evidence"),
    primarilyPromotional: noul("primarily_promotional"),
    rawResponse: response.rawResponse,
    evaluatedAt: new Date().toISOString(),
  };
}

function scoreQuestion(instructions: string) {
  return {
    type: "score" as const,
    instructions,
    criteria: [
      "Little substance, unsupported, promotional, or unusable",
      "Weak or limited evidence and utility",
      "Useful but ordinary or uneven",
      "Strong evidence, analysis, or practical value",
      "Exceptional rigor, originality, and decision value",
    ],
  };
}
