import type { JevQuestionDefinitions } from "../providers/jev";
import type { JevQuestionSchema } from "../validation/jev";

export type IntelligenceContext = {
  profileVersion: string;
  topics: string[];
  namedEntities: string[];
  currentDecisions: string[];
  exclusions: string[];
  editorialBrief: string;
};

export type ProviderDocument = {
  sourceName: string;
  sourceItemId: string;
  title: string;
  author: string | null;
  siteName: string | null;
  sourceUrl: string;
  category: string;
  publishedDate: string | null;
  normalizedText: string;
  contentTruncated: boolean;
};

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
};

export type EvaluationRequest = {
  document: ProviderDocument;
  context: IntelligenceContext;
  rubricVersion: string;
  promptVersion: string;
  questionDefinitions?: JevQuestionDefinitions;
  questionSchema?: JevQuestionSchema;
  promptInstructions?: string;
};

export type EvaluationResult = {
  provider: string;
  model: string;
  rubricVersion: string;
  profileVersion: string;
  promptVersion: string;
  primaryTopic: string;
  contentType: string;
  qualityScore: number;
  personalUtilityScore: number;
  actionabilityScore: number;
  noulResults: Record<string, number>;
  probabilities: Record<string, unknown>;
  confidence: Record<string, number>;
  strategicImplication: string | null;
  rawResponse: unknown;
  usage: ProviderUsage | null;
  evaluatedAt: string;
};

export interface EvaluationProvider {
  evaluate(request: EvaluationRequest): Promise<EvaluationResult>;
}

export type SummaryRequest = {
  document: ProviderDocument;
  context: IntelligenceContext;
  evaluation: Pick<
    EvaluationResult,
    | "primaryTopic"
    | "contentType"
    | "qualityScore"
    | "personalUtilityScore"
    | "actionabilityScore"
  > & { finalScore?: number; triageState?: string };
  promptVersion: string;
};

export type SummaryResult = {
  provider: string;
  model: string;
  promptVersion: string;
  summary: string;
  whyItMatters: string;
  keyPoints: string[];
  recommendedAction: string | null;
  rawResponse: unknown;
  usage: ProviderUsage | null;
  generatedAt: string;
};

export interface SummaryProvider {
  summarize(request: SummaryRequest): Promise<SummaryResult>;
}

export async function evaluateDocument(
  provider: EvaluationProvider,
  request: EvaluationRequest,
): Promise<EvaluationResult> {
  return provider.evaluate(request);
}

export async function summarizeDocument(
  provider: SummaryProvider,
  request: SummaryRequest,
): Promise<SummaryResult> {
  return provider.summarize(request);
}
