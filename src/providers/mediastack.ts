const defaultMediastackEndpoint = "https://api.mediastack.com/v1/news";

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type MediastackArticle = {
  id: string;
  keyword: string;
  title: string;
  source: string | null;
  url: string;
  description: string | null;
  publishedAt: string | null;
  author: string | null;
  imageUrl: string | null;
  language: string | null;
  country: string | null;
  category: string | null;
  content?: string | null;
};

export type MediastackQueryFailure = {
  keyword: string;
  message: string;
  status: number | null;
};

export type MediastackQueryResult = {
  articles: MediastackArticle[];
  failures: MediastackQueryFailure[];
  queriesExecuted: number;
};

export function filterMediastackArticlesByAge(
  articles: MediastackArticle[],
  now: Date,
  windowHours: number,
): MediastackArticle[] {
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error("Mediastack query window must be a positive number");
  }
  const windowStart = now.getTime() - windowHours * 3_600_000;
  return articles.filter((article) => {
    if (!article.publishedAt) return false;
    const publishedAt = Date.parse(article.publishedAt);
    return (
      !Number.isNaN(publishedAt) &&
      publishedAt >= windowStart &&
      publishedAt <= now.getTime()
    );
  });
}

export type MediastackClientOptions = {
  endpoint?: string;
  fetchImpl?: FetchImplementation;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
};

export class MediastackApiError extends Error {
  readonly status: number;
  readonly providerCode: string | null;

  constructor(
    status: number,
    message: string,
    providerCode: string | null = null,
  ) {
    super(`Mediastack request failed with status ${status}: ${message}`);
    this.name = "MediastackApiError";
    this.status = status;
    this.providerCode = providerCode;
  }
}

export class MediastackResponseError extends Error {
  constructor(message: string) {
    super(`Invalid Mediastack response: ${message}`);
    this.name = "MediastackResponseError";
  }
}

export class MediastackClient {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly apiKey: string,
    options: MediastackClientOptions = {},
  ) {
    if (apiKey.trim() === "") {
      throw new Error("MEDIASTACK_API_KEY is required");
    }
    this.endpoint = options.endpoint ?? defaultMediastackEndpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? (() => new Date());
  }

  async queryKeyword(
    keyword: string,
    queryWindowHours: number,
  ): Promise<MediastackArticle[]> {
    validateKeyword(keyword);
    validateQueryWindow(queryWindowHours);

    const end = this.now();
    const start = new Date(end.getTime() - queryWindowHours * 60 * 60 * 1000);
    const url = new URL(this.endpoint);
    url.searchParams.set("access_key", this.apiKey);
    url.searchParams.set("keywords", keyword.trim());
    url.searchParams.set("languages", "en");
    url.searchParams.set("date", `${formatDate(start)},${formatDate(end)}`);

    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MediastackResponseError("response body was not valid JSON");
    }

    const providerError = readProviderError(payload);
    if (!response.ok || providerError) {
      throw new MediastackApiError(
        response.status,
        providerError?.message ?? "request was not successful",
        providerError?.code ?? null,
      );
    }
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new MediastackResponseError("data must be an array");
    }

    return payload.data.map((article, index) =>
      parseArticle(article, keyword, index),
    );
  }

  async queryKeywords(
    keywords: string[],
    queryWindowHours: number,
    queryIntervalSeconds: number,
    onQuery?: (keyword: string) => Promise<void> | void,
  ): Promise<MediastackQueryResult> {
    if (keywords.length === 0) {
      throw new Error("At least one Mediastack keyword is required");
    }
    if (!Number.isFinite(queryIntervalSeconds) || queryIntervalSeconds < 0) {
      throw new Error("Mediastack query interval must be non-negative");
    }
    validateQueryWindow(queryWindowHours);

    const articles: MediastackArticle[] = [];
    const failures: MediastackQueryFailure[] = [];
    let queriesExecuted = 0;
    for (const [index, keyword] of keywords.entries()) {
      try {
        await onQuery?.(keyword);
        articles.push(...(await this.queryKeyword(keyword, queryWindowHours)));
      } catch (error) {
        failures.push({
          keyword,
          message: safeMessage(error),
          status: error instanceof MediastackApiError ? error.status : null,
        });
      }
      queriesExecuted += 1;
      if (index < keywords.length - 1 && queryIntervalSeconds > 0) {
        await this.sleep(queryIntervalSeconds * 1000);
      }
    }

    return { articles, failures, queriesExecuted };
  }
}

export function createMediastackClientFromEnv(
  environmentVariable = "MEDIASTACK_API_KEY",
  options: MediastackClientOptions = {},
): MediastackClient {
  const apiKey = process.env[environmentVariable];
  if (!apiKey) {
    throw new Error(`${environmentVariable} is required`);
  }
  return new MediastackClient(apiKey, options);
}

function parseArticle(
  value: unknown,
  keyword: string,
  index: number,
): MediastackArticle {
  if (!isRecord(value)) {
    throw new MediastackResponseError(`article ${index} must be an object`);
  }
  const title = requiredString(value.title, `article ${index}.title`);
  const url = requiredString(value.url, `article ${index}.url`);
  return {
    id: `${url}|${optionalString(value.published_at) ?? "undated"}`,
    keyword: keyword.trim(),
    title,
    source: optionalString(value.source),
    url,
    description: optionalString(value.description),
    publishedAt: optionalString(value.published_at),
    author: optionalString(value.author),
    imageUrl: optionalString(value.image),
    language: optionalString(value.language),
    country: optionalString(value.country),
    category: optionalString(value.category),
  };
}

function readProviderError(
  payload: unknown,
): { code: string | null; message: string } | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  return {
    code: typeof payload.error.code === "string" ? payload.error.code : null,
    message:
      typeof payload.error.message === "string"
        ? payload.error.message.slice(0, 300)
        : "provider returned an error",
  };
}

function validateKeyword(keyword: string): void {
  if (keyword.trim() === "") throw new Error("Mediastack keyword is required");
}

function validateQueryWindow(queryWindowHours: number): void {
  if (!Number.isFinite(queryWindowHours) || queryWindowHours <= 0) {
    throw new Error("Mediastack query window must be a positive number");
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : typeof value === "string"
      ? value
      : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MediastackResponseError(`${field} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Unknown Mediastack error";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
