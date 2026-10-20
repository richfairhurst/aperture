import type {
  SummaryProvider,
  SummaryRequest,
  SummaryResult,
} from "../contracts/providers";
import {
  buildReportSummaryPrompt,
  parseReportSummary,
  reportSummaryJsonSchema,
  reportSummaryPromptVersion,
  type ReportSummaryRequest,
  type ReportSummaryResult,
} from "../reports/summary";

const defaultEndpoint = "https://api.openai.com/v1/chat/completions";
const defaultModel = "gpt-5-nano";
const defaultTimeoutMs = 120_000;

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenAISummaryClientOptions = {
  fetchImpl?: FetchImplementation;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
};

export class OpenAISummaryApiError extends Error {
  readonly status: number;

  constructor(status: number, detail?: string) {
    super(
      `OpenAI summary request failed with status ${status}${detail ? `: ${detail}` : ""}`,
    );
    this.name = "OpenAISummaryApiError";
    this.status = status;
  }
}

export class OpenAISummaryResponseError extends Error {
  constructor(message: string) {
    super(`Invalid OpenAI summary response: ${message}`);
    this.name = "OpenAISummaryResponseError";
  }
}

export class OpenAISummaryClient implements SummaryProvider {
  private readonly fetchImpl: FetchImplementation;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: OpenAISummaryClientOptions = {},
  ) {
    if (apiKey.trim().length === 0) {
      throw new Error("OPENAI_API_KEY is required");
    }

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? defaultEndpoint;
    this.model = options.model ?? process.env.SUMMARY_MODEL ?? defaultModel;
    this.timeoutMs = options.timeoutMs ?? readTimeoutMs();
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "intelligence_feed_summary",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  summary: { type: "string", minLength: 1, maxLength: 420 },
                  whyItMatters: {
                    type: "string",
                    minLength: 1,
                    maxLength: 240,
                  },
                  keyPoints: {
                    type: "array",
                    minItems: 3,
                    maxItems: 3,
                    items: { type: "string", minLength: 1, maxLength: 160 },
                  },
                  recommendedAction: {
                    anyOf: [
                      { type: "string", minLength: 1, maxLength: 240 },
                      { type: "null" },
                    ],
                  },
                },
                required: [
                  "summary",
                  "whyItMatters",
                  "keyPoints",
                  "recommendedAction",
                ],
              },
            },
          },
          messages: [
            {
              role: "system",
              content:
                "Create a highly digestible intelligence-feed briefing. Every field is required. Keep summary to 1-2 sentences and under 60 words. Keep whyItMatters to one sentence and under 35 words. Return exactly 3 short keyPoints, each under 20 words. Keep recommendedAction to one short sentence under 35 words, or null when no action is warranted. whyItMatters must never be empty; if relevance is limited, explain its value as context.",
            },
            { role: "user", content: buildPrompt(request) },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new OpenAISummaryApiError(
          response.status,
          await readApiError(response),
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new OpenAISummaryResponseError("response body was not JSON");
      }

      const content = readContent(payload);
      const parsed = parseSummary(content);
      return {
        provider: "openai",
        model: this.model,
        promptVersion: request.promptVersion,
        summary: parsed.summary,
        whyItMatters: parsed.whyItMatters,
        keyPoints: parsed.keyPoints,
        recommendedAction: parsed.recommendedAction,
        rawResponse: payload,
        usage: readUsage(payload),
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new OpenAISummaryResponseError(
          `request timed out after ${this.timeoutMs}ms`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async summarizeReport(
    request: ReportSummaryRequest,
  ): Promise<ReportSummaryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "report_intellectual_summary",
              strict: true,
              schema: reportSummaryJsonSchema,
            },
          },
          messages: [
            {
              role: "system",
              content:
                "Analyze this report as an intellectual and strategic work. Extract its deepest ideas, wisdom, reusable mental models, and evidence-grounded implications. Follow the JSON schema exactly.",
            },
            { role: "user", content: buildReportSummaryPrompt(request) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OpenAISummaryApiError(
          response.status,
          await readApiError(response),
        );
      }
      const payload = await response.json();
      const content = readContent(payload);
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(content);
      } catch {
        throw new OpenAISummaryResponseError(
          "report summary content was not JSON",
        );
      }
      const parsed = parseReportSummary(parsedValue);
      return {
        ...parsed,
        provider: "openai",
        model: this.model,
        promptVersion: reportSummaryPromptVersion,
        rawResponse: parsedValue,
        usage: readUsage(payload),
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new OpenAISummaryResponseError(
          `request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readApiError(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (
      isRecord(payload) &&
      isRecord(payload.error) &&
      typeof payload.error.message === "string"
    ) {
      return payload.error.message.slice(0, 300);
    }
  } catch {
    // Preserve the safe status-only error when the provider body is not JSON.
  }

  return undefined;
}

export function createOpenAISummaryClientFromEnv(
  options: OpenAISummaryClientOptions = {},
): OpenAISummaryClient {
  const apiKey = process.env.SUMMARY_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY or SUMMARY_API_KEY is required");
  }

  return new OpenAISummaryClient(apiKey, options);
}

function buildPrompt(request: SummaryRequest): string {
  return [
    `Title: ${request.document.title}`,
    `Source: ${request.document.siteName ?? "Unknown"}`,
    `URL: ${request.document.sourceUrl}`,
    `Topic: ${request.evaluation.primaryTopic}`,
    `Content type: ${request.evaluation.contentType}`,
    `Quality score: ${request.evaluation.qualityScore}/4`,
    `Personal utility score: ${request.evaluation.personalUtilityScore}/4`,
    `Actionability score: ${request.evaluation.actionabilityScore}/4`,
    `Triage: ${request.evaluation.triageState ?? "Unknown"}`,
    `Editorial brief: ${request.context.editorialBrief}`,
    "",
    "Summarize the following document for a busy executive:",
    request.document.normalizedText,
  ].join("\n");
}

function readContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new OpenAISummaryResponseError("choices were missing");
  }

  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new OpenAISummaryResponseError("message was missing");
  }

  const content = first.message.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new OpenAISummaryResponseError("message content was empty");
  }

  return content;
}

function parseSummary(content: string): {
  summary: string;
  whyItMatters: string;
  keyPoints: string[];
  recommendedAction: string | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new OpenAISummaryResponseError("message content was not JSON");
  }

  if (!isRecord(value)) {
    throw new OpenAISummaryResponseError("summary was not an object");
  }

  const summary = requiredString(value.summary, "summary");
  const whyItMatters = requiredString(value.whyItMatters, "whyItMatters");
  if (!Array.isArray(value.keyPoints) || value.keyPoints.length !== 3) {
    throw new OpenAISummaryResponseError(
      "keyPoints must contain exactly 3 items",
    );
  }

  const keyPoints = value.keyPoints.map((point, index) =>
    requiredString(point, `keyPoints[${index}]`),
  );
  const recommendedAction =
    value.recommendedAction === null
      ? null
      : requiredString(value.recommendedAction, "recommendedAction");

  return { summary, whyItMatters, keyPoints, recommendedAction };
}

function readUsage(payload: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return null;
  }

  return {
    inputTokens: numberOrUndefined(payload.usage.prompt_tokens),
    outputTokens: numberOrUndefined(payload.usage.completion_tokens),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OpenAISummaryResponseError(`${field} must be a non-empty string`);
  }

  return value.trim();
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readTimeoutMs(value = process.env.SUMMARY_TIMEOUT_MS): number {
  if (value === undefined || value.trim() === "") {
    return defaultTimeoutMs;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("SUMMARY_TIMEOUT_MS must be a positive integer");
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
