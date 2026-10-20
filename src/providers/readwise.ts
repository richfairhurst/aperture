const readwiseEndpoint = "https://readwise.io/api/v3/list/";

export type ReadwiseDocument = {
  id: string;
  url: string;
  sourceUrl: string | null;
  title: string;
  author: string | null;
  htmlContent: string | null;
  category: string;
  createdAt: string;
  updatedAt: string;
  publishedDate: string | null;
  savedAt: string | null;
  siteName: string | null;
  readwiseUrl: string | null;
  imageUrl: string | null;
};

export type ReadwisePage = {
  documents: ReadwiseDocument[];
  nextPageCursor: string | null;
};

export type ReadwiseListOptions = {
  updatedAfter?: string;
  withHtmlContent?: boolean;
};

export type ReadwiseClientOptions = {
  fetchImpl?: FetchImplementation;
  endpoint?: string;
};

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ReadwiseApiError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;

  constructor(status: number, retryAfter: string | null) {
    super(`Readwise request failed with status ${status}`);
    this.name = "ReadwiseApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class ReadwiseResponseError extends Error {
  constructor(message: string) {
    super(`Invalid Readwise response: ${message}`);
    this.name = "ReadwiseResponseError";
  }
}

export class ReadwiseClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly endpoint: string;

  constructor(
    private readonly token: string,
    options: ReadwiseClientOptions = {},
  ) {
    if (token.trim().length === 0) {
      throw new Error("READWISE_API_TOKEN is required");
    }

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? readwiseEndpoint;
  }

  async fetchPage(
    options: ReadwiseListOptions = {},
    pageCursor?: string,
  ): Promise<ReadwisePage> {
    const url = new URL(this.endpoint);
    url.searchParams.set(
      "withHtmlContent",
      String(options.withHtmlContent ?? true),
    );

    if (options.updatedAfter) {
      url.searchParams.set("updatedAfter", options.updatedAfter);
    }

    if (pageCursor) {
      url.searchParams.set("pageCursor", pageCursor);
    }

    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Token ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new ReadwiseApiError(
        response.status,
        response.headers.get("retry-after"),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ReadwiseResponseError("response body was not valid JSON");
    }

    return parseReadwisePage(payload);
  }

  async listDocuments(
    options: ReadwiseListOptions = {},
  ): Promise<ReadwiseDocument[]> {
    const documents: ReadwiseDocument[] = [];
    let pageCursor: string | undefined;

    do {
      const page = await this.fetchPage(options, pageCursor);
      documents.push(...page.documents);
      pageCursor = page.nextPageCursor ?? undefined;
    } while (pageCursor);

    return documents;
  }
}

export function createReadwiseClientFromEnv(
  options: ReadwiseClientOptions = {},
): ReadwiseClient {
  const token = process.env.READWISE_API_TOKEN;
  if (!token) {
    throw new Error("READWISE_API_TOKEN is required");
  }

  return new ReadwiseClient(token, options);
}

function parseReadwisePage(payload: unknown): ReadwisePage {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new ReadwiseResponseError("results must be an array");
  }

  const documents = payload.results.map((document, index) =>
    parseReadwiseDocument(document, index),
  );
  const nextPageCursor = payload.nextPageCursor;

  if (
    nextPageCursor !== undefined &&
    nextPageCursor !== null &&
    typeof nextPageCursor !== "string"
  ) {
    throw new ReadwiseResponseError("nextPageCursor must be a string or null");
  }

  return {
    documents,
    nextPageCursor: nextPageCursor ?? null,
  };
}

function parseReadwiseDocument(
  value: unknown,
  index: number,
): ReadwiseDocument {
  if (!isRecord(value)) {
    throw new ReadwiseResponseError(`result ${index} must be an object`);
  }

  return {
    id: requiredString(value.id, `result ${index}.id`),
    url: requiredString(value.url, `result ${index}.url`),
    sourceUrl: optionalString(value.source_url, `result ${index}.source_url`),
    title: requiredString(value.title, `result ${index}.title`),
    author: optionalString(value.author, `result ${index}.author`),
    htmlContent: optionalString(
      value.html_content,
      `result ${index}.html_content`,
    ),
    category: requiredString(value.category, `result ${index}.category`),
    createdAt: requiredString(value.created_at, `result ${index}.created_at`),
    updatedAt: requiredString(value.updated_at, `result ${index}.updated_at`),
    publishedDate: optionalString(
      value.published_date,
      `result ${index}.published_date`,
    ),
    savedAt: optionalString(value.saved_at, `result ${index}.saved_at`),
    siteName: optionalString(value.site_name, `result ${index}.site_name`),
    readwiseUrl: optionalString(
      value.readwise_url,
      `result ${index}.readwise_url`,
    ),
    imageUrl: optionalString(value.image_url, `result ${index}.image_url`),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReadwiseResponseError(`${field} must be a non-empty string`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new ReadwiseResponseError(`${field} must be a string or null`);
  }

  return value;
}
