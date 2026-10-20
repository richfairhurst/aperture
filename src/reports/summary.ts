import type {
  IntelligenceContext,
  ProviderDocument,
} from "../contracts/providers";

export const reportSummaryPromptVersion = "report-summary-v1";

export type ReportSummaryRequest = {
  document: ProviderDocument;
  context: IntelligenceContext;
  reportPublicationDate: string | null;
  activityStartDate: string | null;
  activityEndDate: string | null;
  reportType: string;
  activityStatus: string;
};

export type ReportReadVerdict =
  "read_now" | "read_selectively" | "save_for_reference" | "skip";

export type ReportSummaryResult = {
  provider: string;
  model: string;
  promptVersion: string;
  readVerdict: ReportReadVerdict;
  summary: string;
  oneSentenceSummary: string;
  keyTakeaways: string[];
  importantFindings: string[];
  deepInsights: string[];
  mentalModels: string[];
  practicalImplications: string[];
  recommendations: string[];
  methodologyAndLimitations: string;
  activityContext: string;
  quotes: string[];
  references: string[];
  rawResponse: unknown;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  generatedAt: string;
};

export const reportSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    readVerdict: {
      type: "string",
      enum: ["read_now", "read_selectively", "save_for_reference", "skip"],
    },
    summary: { type: "string", minLength: 1, maxLength: 900 },
    oneSentenceSummary: { type: "string", minLength: 1, maxLength: 240 },
    keyTakeaways: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    importantFindings: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    deepInsights: {
      type: "array",
      minItems: 3,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 360 },
    },
    mentalModels: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    practicalImplications: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    recommendations: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    methodologyAndLimitations: { type: "string", minLength: 1, maxLength: 700 },
    activityContext: { type: "string", minLength: 1, maxLength: 500 },
    quotes: {
      type: "array",
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    references: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 240 },
    },
  },
  required: [
    "readVerdict",
    "summary",
    "oneSentenceSummary",
    "keyTakeaways",
    "importantFindings",
    "deepInsights",
    "mentalModels",
    "practicalImplications",
    "recommendations",
    "methodologyAndLimitations",
    "activityContext",
    "quotes",
    "references",
  ],
} as const;

export function buildReportSummaryPrompt(
  request: ReportSummaryRequest,
): string {
  return [
    `Title: ${request.document.title}`,
    `Source: ${request.document.siteName ?? "Unknown"}`,
    `URL: ${request.document.sourceUrl}`,
    `Report type: ${request.reportType}`,
    `Publication date: ${request.reportPublicationDate ?? "Unknown"}`,
    `Activity period: ${request.activityStartDate ?? "Unknown"} to ${request.activityEndDate ?? "Unknown"}`,
    `Activity classification: ${request.activityStatus}`,
    `Editorial brief: ${request.context.editorialBrief}`,
    "",
    "Extract the report's deepest intellectual value and help the reader decide whether deeper review is worthwhile.",
    "Prioritize surprising ideas, reusable mental models, wisdom, and insights that generalize beyond this report.",
    "Separate evidence, interpretation, forecasts, and recommendations.",
    "Use exact quotes only when they appear in the supplied text. Never invent facts, statistics, references, or quotes.",
    "Do not treat a recent publication date or index date as proof of recent underlying activity.",
    "Return only the requested JSON object.",
    "",
    request.document.normalizedText,
  ].join("\n");
}

export function parseReportSummary(
  value: unknown,
): Omit<
  ReportSummaryResult,
  | "provider"
  | "model"
  | "promptVersion"
  | "rawResponse"
  | "usage"
  | "generatedAt"
> {
  if (!isRecord(value)) throw new Error("report summary must be an object");
  const verdict = value.readVerdict;
  if (!isReadVerdict(verdict)) throw new Error("readVerdict is invalid");
  return {
    readVerdict: verdict,
    summary: requiredString(value.summary, "summary"),
    oneSentenceSummary: requiredString(
      value.oneSentenceSummary,
      "oneSentenceSummary",
    ),
    keyTakeaways: requiredStrings(value.keyTakeaways, "keyTakeaways", 3, 8),
    importantFindings: requiredStrings(
      value.importantFindings,
      "importantFindings",
      1,
      10,
    ),
    deepInsights: requiredStrings(value.deepInsights, "deepInsights", 3, 8),
    mentalModels: requiredStrings(value.mentalModels, "mentalModels", 1, 6),
    practicalImplications: requiredStrings(
      value.practicalImplications,
      "practicalImplications",
      2,
      6,
    ),
    recommendations: requiredStrings(
      value.recommendations,
      "recommendations",
      2,
      6,
    ),
    methodologyAndLimitations: requiredString(
      value.methodologyAndLimitations,
      "methodologyAndLimitations",
    ),
    activityContext: requiredString(value.activityContext, "activityContext"),
    quotes: optionalStrings(value.quotes, "quotes", 5),
    references: optionalStrings(value.references, "references", 12),
  };
}

function isReadVerdict(value: unknown): value is ReportReadVerdict {
  return (
    value === "read_now" ||
    value === "read_selectively" ||
    value === "save_for_reference" ||
    value === "skip"
  );
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}
function requiredStrings(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`${field} must contain ${min} to ${max} items`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}
function optionalStrings(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${field} must contain no more than ${max} items`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
