import type { EvaluationRequest } from "../contracts/providers";
import {
  defaultJevQuestionSchema,
  validateJevResponse,
  type ValidatedJevResponse,
} from "../validation/jev";

const jevEndpoint = "https://api.typesafe.ai/v1/systemone";
const defaultJevModel = "jev-latest";
const defaultJevTimeoutMs = 20_000;

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type JevClientOptions = {
  fetchImpl?: FetchImplementation;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
};

export class JevApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfter: string | null;

  constructor(status: number, retryAfter: string | null) {
    super(`Jev request failed with status ${status}`);
    this.name = "JevApiError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
    this.retryAfter = retryAfter;
  }
}

export class JevTimeoutError extends Error {
  readonly code = "jev_timeout";

  constructor(timeoutMs: number) {
    super(`Jev request timed out after ${timeoutMs}ms`);
    this.name = "JevTimeoutError";
  }
}

export class JevResponseError extends Error {
  readonly code = "invalid_jev_response";

  constructor(message: string) {
    super(`Invalid Jev response: ${message}`);
    this.name = "JevResponseError";
  }
}

export type JevChoiceRequest = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

export type JevScoreRequest = {
  type: "score";
  instructions: string;
  criteria: string[];
};

export type JevNoulRequest = {
  type: "noul";
  instructions: string;
};

export type JevRequestQuestion =
  JevChoiceRequest | JevScoreRequest | JevNoulRequest;

export type JevQuestionDefinitions = Record<string, JevRequestQuestion>;

export const defaultJevQuestions: JevQuestionDefinitions = {
  primary_topic: {
    type: "choice",
    instructions: "Which primary topic best fits this document?",
    criteria: {
      ai: "Artificial intelligence, models, governance, or applications",
      cybersecurity: "Security, cyber risk, threats, resilience, or privacy",
      geopolitics:
        "Geopolitics, national security, defense, intelligence, or state power",
      technology_strategy: "Technology adoption, platforms, or transformation",
      executive_decision_making:
        "Leadership, governance, or operating decisions",
      business_opportunity:
        "Commercial, advisory, investment, or career relevance",
      other: "Does not fit the focus areas",
    },
  },
  content_type: {
    type: "choice",
    instructions: "Which content type best fits this document?",
    criteria: {
      analysis: "Analysis",
      news: "News",
      research: "Research",
      opinion: "Opinion",
      how_to: "How-to or practical guidance",
      interview: "Interview",
      announcement: "Announcement",
      other: "Other",
    },
  },
  quality_score: {
    type: "score",
    instructions:
      "How valuable is this document as content? Reward new, substantive, well-supported insight. Penalize routine recurring roundups, link dumps, repetitive coverage, and articles that mostly summarize items the reader is likely to have already seen.",
    criteria: [
      "Little substance, promotional, repetitive, or unusable",
      "Limited substance or weakly supported claims",
      "Useful but ordinary or uneven",
      "Strong analysis, evidence, or explanation",
      "Exceptional insight, originality, evidence, and lasting value",
    ],
  },
  personal_utility_score: {
    type: "score",
    instructions:
      "How useful is this document for the user's current focus? Judge specific decision relevance, not just broad topical overlap. A generic roundup should not score highly merely because it contains several relevant keywords.",
    criteria: [
      "Unrelated to current interests",
      "Tangentially relevant with no clear use",
      "Relevant background or context",
      "Directly useful for work, research, writing, or decisions",
      "Immediately actionable or strategically important",
    ],
  },
  actionability_score: {
    type: "score",
    instructions:
      "How actionable is the implication of this document? Reward a concrete, new, decision-relevant implication. Do not confuse a roundup's many items, warnings, or recommendations with a clear action for this user.",
    criteria: [
      "No identifiable implication or action",
      "Vague implication",
      "Useful implication but no clear next step",
      "Clear practical action or decision implication",
      "Specific, high-value action that should be considered promptly",
    ],
  },
  contains_evidence: {
    type: "noul",
    instructions:
      "Does the document contain a concrete claim supported by evidence?",
  },
  has_mental_model: {
    type: "noul",
    instructions:
      "Does the document contain a reusable mental model or framework?",
  },
  has_relevant_action: {
    type: "noul",
    instructions:
      "Does the document contain a concrete action relevant to the user's focus?",
  },
  worth_sharing_executive: {
    type: "noul",
    instructions: "Is this likely worth sharing with an executive audience?",
  },
  primarily_promotional: {
    type: "noul",
    instructions: "Does this appear primarily promotional or low-signal?",
  },
};

export class JevClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    options: JevClientOptions = {},
  ) {
    if (token.trim().length === 0) {
      throw new Error("TYPESAFE_API_KEY is required");
    }

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? jevEndpoint;
    this.model = options.model ?? process.env.JEV_MODEL ?? defaultJevModel;
    this.timeoutMs = options.timeoutMs ?? readJevTimeoutMs();

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("JEV_TIMEOUT_MS must be a positive integer");
    }
  }

  get modelName(): string {
    return this.model;
  }

  async evaluate(request: EvaluationRequest): Promise<ValidatedJevResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: buildJevState(request),
          model: this.model,
          questions: request.questionDefinitions ?? defaultJevQuestions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new JevApiError(
          response.status,
          response.headers.get("retry-after"),
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new JevResponseError("response body was not valid JSON");
      }

      try {
        return validateJevResponse(
          payload,
          request.questionSchema ?? defaultJevQuestionSchema,
        );
      } catch (error) {
        if (error instanceof Error) {
          throw new JevResponseError(error.message);
        }

        throw new JevResponseError(
          "response did not match the configured schema",
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new JevTimeoutError(this.timeoutMs);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createJevClientFromEnv(
  options: JevClientOptions = {},
): JevClient {
  const token = process.env.TYPESAFE_API_KEY;
  if (!token) {
    throw new Error("TYPESAFE_API_KEY is required");
  }

  return new JevClient(token, options);
}

export function buildJevState(request: EvaluationRequest): string {
  const author = request.document.author ?? "Unknown";
  const siteName = request.document.siteName ?? "Unknown";
  const publishedDate = request.document.publishedDate ?? "Unknown";

  return [
    `Title: ${request.document.title}`,
    `Source: ${siteName}`,
    `Author: ${author}`,
    `Published: ${publishedDate}`,
    `URL: ${request.document.sourceUrl}`,
    `Category: ${request.document.category}`,
    "",
    "Intelligence profile:",
    `Topics: ${request.context.topics.join(", ") || "None specified"}`,
    `Named entities: ${request.context.namedEntities.join(", ") || "None specified"}`,
    `Current decisions: ${request.context.currentDecisions.join(", ") || "None specified"}`,
    `Exclusions: ${request.context.exclusions.join(", ") || "None specified"}`,
    `Editorial brief: ${request.context.editorialBrief}`,
    ...(request.promptInstructions
      ? ["Evaluation mode instructions:", request.promptInstructions]
      : []),
    "Scoring calibration:",
    "Prefer a specific, material new development over a routine digest or recurring roundup.",
    "Do not reward novelty of wording or a dramatic headline without corresponding evidence and substance.",
    "When content repeats familiar coverage, reduce quality and personal utility unless it adds materially new evidence, analysis, or implications.",
    "Treat actionability as a concrete implication for this user's work or decisions, not as the presence of advice, links, or a long list of events.",
    "",
    "Document text:",
    request.document.normalizedText,
  ].join("\n");
}

function readJevTimeoutMs(value = process.env.JEV_TIMEOUT_MS): number {
  if (value === undefined || value.trim() === "") {
    return defaultJevTimeoutMs;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("JEV_TIMEOUT_MS must be a positive integer");
  }

  return parsed;
}
