import {
  isNewGitHubReportAsset,
  parseReportTimestamp,
  type GitHubReportChange,
  type ReportCandidate,
  type ReportType,
  selectGitHubReportContent,
} from "./domain";
import { readResponseBytes } from "../utils/response";

const maxReportJsonResponseBytes = 5_000_000;
const maxReportContentResponseBytes = 20_000_000;

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ReportDiscoveryResult = {
  candidates: ReportCandidate[];
  failures: string[];
};

export type ReportDiscoveryClient = {
  discover(input: {
    since: Date;
    observedAt: Date;
    signal?: AbortSignal;
  }): Promise<ReportCandidate[]>;
};

export type ReportApiClientOptions = {
  endpoint?: string;
  fetchImpl?: FetchImplementation;
  maxDetailFetches?: number;
  requestTimeoutMs?: number;
  shouldFetchDetail?: (candidate: ReportCandidate) => boolean;
};

export class ReportApiError extends Error {
  readonly status: number;

  constructor(source: string, status: number) {
    super(`${source} request failed with status ${status}`);
    this.name = "ReportApiError";
    this.status = status;
  }
}

export class OrklReportClient implements ReportDiscoveryClient {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly requestTimeoutMs: number;

  constructor(options: ReportApiClientOptions = {}) {
    this.endpoint =
      options.endpoint ?? "https://orkl.eu/api/v1/library/entries";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async discover(input: {
    since: Date;
    observedAt: Date;
    signal?: AbortSignal;
  }): Promise<ReportCandidate[]> {
    const payloads = await fetchReportPages(
      "ORKL",
      this.endpoint,
      input.since,
      this.fetchImpl,
      this.requestTimeoutMs,
      input.signal,
    );
    return payloads.flatMap((payload) =>
      parseReportItems(payload, "orkl", input.observedAt),
    );
  }
}

export class RostiReportClient implements ReportDiscoveryClient {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly maxDetailFetches: number;
  private readonly shouldFetchDetail:
    ((candidate: ReportCandidate) => boolean) | undefined;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: ReportApiClientOptions = {},
  ) {
    if (apiKey.trim() === "") throw new Error("ROSTI_API_KEY is required");
    this.endpoint = options.endpoint ?? "https://api.rosti.dev/v2/reports";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxDetailFetches = options.maxDetailFetches ?? 100;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.shouldFetchDetail = options.shouldFetchDetail;
  }

  async discover(input: {
    since: Date;
    observedAt: Date;
    signal?: AbortSignal;
  }): Promise<ReportCandidate[]> {
    const payloads = await fetchRostiReportPages(
      this.endpoint,
      input.since,
      this.fetchImpl,
      this.apiKey,
      this.requestTimeoutMs,
      input.signal,
    );
    const candidates = payloads.flatMap((payload) =>
      parseReportItems(payload, "rosti", input.observedAt),
    );
    const detailCandidates = candidates
      .filter(
        (candidate) =>
          !candidate.contentPayload?.markdownText &&
          (!this.shouldFetchDetail || this.shouldFetchDetail(candidate)),
      )
      .slice(0, this.maxDetailFetches);
    for (let offset = 0; offset < detailCandidates.length; offset += 10) {
      await Promise.all(
        detailCandidates.slice(offset, offset + 10).map(async (candidate) => {
          try {
            const response = await fetchWithTimeout(
              this.fetchImpl,
              sameOriginUrl(
                candidate.provenance.canonicalUrl,
                this.endpoint,
                "ROSTI detail",
              ),
              {
                headers: {
                  Accept: "text/html, text/plain",
                  "X-Api-Key": this.apiKey,
                },
                redirect: "manual",
              },
              this.requestTimeoutMs,
              "ROSTI detail",
              input.signal,
            );
            if (!response.ok) return;
            const text = new TextDecoder().decode(
              await readResponseBytes(response, maxReportJsonResponseBytes),
            );
            if (text.trim() !== "") {
              candidate.contentPayload = { markdownText: htmlToText(text) };
            }
          } catch {
            // One unavailable report must not block the rest of the source.
          }
        }),
      );
    }
    return candidates.filter(
      (candidate) =>
        Boolean(candidate.contentPayload?.markdownText) ||
        Boolean(candidate.contentPayload?.pdfBytes?.byteLength),
    );
  }
}

export type GitHubReportClientOptions = {
  owner?: string;
  repository?: string;
  fetchImpl?: FetchImplementation;
  fetchMarkdown?: (path: string, ref: string) => Promise<string | null>;
  maxDetailFetches?: number;
  requestTimeoutMs?: number;
  shouldFetchDetail?: (candidate: ReportCandidate) => boolean;
};

export class GitHubAnnualReportsClient implements ReportDiscoveryClient {
  private readonly owner: string;
  private readonly repository: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly fetchMarkdown: (
    path: string,
    ref: string,
  ) => Promise<string | null>;
  private readonly maxDetailFetches: number;
  private readonly shouldFetchDetail:
    ((candidate: ReportCandidate) => boolean) | undefined;
  private readonly requestTimeoutMs: number;

  constructor(options: GitHubReportClientOptions = {}) {
    this.owner = options.owner ?? "jacobdjwilson";
    this.repository = options.repository ?? "awesome-annual-security-reports";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxDetailFetches = options.maxDetailFetches ?? 100;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.shouldFetchDetail = options.shouldFetchDetail;
    this.fetchMarkdown =
      options.fetchMarkdown ??
      (async (path, ref) => {
        const url = `https://raw.githubusercontent.com/${this.owner}/${this.repository}/${ref}/${encodePath(path)}`;
        const response = await fetchWithTimeout(
          this.fetchImpl,
          url,
          { headers: { Accept: "text/plain" } },
          this.requestTimeoutMs,
          "GitHub report content",
        );
        return response.ok
          ? new TextDecoder().decode(
              await readResponseBytes(response, maxReportJsonResponseBytes),
            )
          : null;
      });
  }

  async discover(input: {
    since: Date;
    observedAt: Date;
    signal?: AbortSignal;
  }): Promise<ReportCandidate[]> {
    const commitsUrl = new URL(
      `https://api.github.com/repos/${this.owner}/${this.repository}/commits`,
    );
    commitsUrl.searchParams.set("path", "Annual Security Reports");
    commitsUrl.searchParams.set("since", input.since.toISOString());
    commitsUrl.searchParams.set("per_page", "100");
    const commits = await fetchJson(
      "GitHub",
      commitsUrl,
      this.fetchImpl,
      { Accept: "application/vnd.github+json" },
      this.requestTimeoutMs,
      input.signal,
    );
    if (!Array.isArray(commits)) {
      throw new Error("Invalid GitHub response: commits must be an array");
    }

    const candidates: ReportCandidate[] = [];
    let detailFetches = 0;
    for (const commit of commits) {
      if (!isRecord(commit) || typeof commit.sha !== "string") continue;
      const detailUrl = `https://api.github.com/repos/${this.owner}/${this.repository}/commits/${commit.sha}`;
      const detail = await fetchJson(
        "GitHub",
        detailUrl,
        this.fetchImpl,
        { Accept: "application/vnd.github+json" },
        this.requestTimeoutMs,
        input.signal,
      );
      if (!isRecord(detail) || !Array.isArray(detail.files)) continue;
      for (const file of detail.files) {
        if (!isRecord(file) || typeof file.filename !== "string") continue;
        const change: GitHubReportChange = {
          path: file.filename,
          status: normalizeGitHubStatus(file.status),
        };
        if (!isNewGitHubReportAsset(change)) continue;
        const candidate = githubCandidate(
          change.path,
          input.observedAt,
          commit.sha,
        );
        const markdownPath = markdownPathForPdf(change.path);
        if (this.shouldFetchDetail && !this.shouldFetchDetail(candidate)) {
          continue;
        }
        if (detailFetches >= this.maxDetailFetches) continue;
        detailFetches += 1;
        const markdownText = await withTimeout(
          this.fetchMarkdown(markdownPath, commit.sha),
          this.requestTimeoutMs,
          "GitHub report content",
          input.signal,
        );
        candidate.selectedContent = selectGitHubReportContent({
          pdfUrl: candidate.provenance.canonicalUrl,
          markdownText,
        });
        if (markdownText) {
          candidate.contentPayload = { markdownText };
        } else {
          const pdfResponse = await fetchWithTimeout(
            this.fetchImpl,
            `https://raw.githubusercontent.com/${this.owner}/${this.repository}/${commit.sha}/${encodePath(change.path)}`,
            { headers: { Accept: "application/pdf" } },
            this.requestTimeoutMs,
            "GitHub report PDF",
            input.signal,
          );
          candidate.contentPayload = {
            pdfBytes: pdfResponse.ok
              ? await readResponseBytes(
                  pdfResponse,
                  maxReportContentResponseBytes,
                )
              : null,
          };
        }
        candidates.push(candidate);
      }
    }
    return deduplicateCandidates(candidates);
  }
}

export async function discoverReports(
  clients: Record<string, ReportDiscoveryClient>,
  input: {
    since: Date;
    observedAt?: Date;
    signal?: AbortSignal;
    onSourceStage?: (
      source: string,
      stage: "running" | "completed" | "failed",
    ) => void;
  },
): Promise<ReportDiscoveryResult> {
  const observedAt = input.observedAt ?? new Date();
  const candidates: ReportCandidate[] = [];
  const failures: string[] = [];
  for (const [source, client] of Object.entries(clients)) {
    input.onSourceStage?.(source, "running");
    try {
      candidates.push(
        ...(await client.discover({
          since: input.since,
          observedAt,
          signal: input.signal,
        })),
      );
      input.onSourceStage?.(source, "completed");
    } catch (error) {
      input.onSourceStage?.(source, "failed");
      failures.push(`${source}: ${safeMessage(error)}`);
    }
  }
  return { candidates: deduplicateCandidates(candidates), failures };
}

function githubCandidate(
  path: string,
  observedAt: Date,
  commitSha: string,
): ReportCandidate {
  const year = Number(path.match(/^Annual Security Reports\/(\d{4})\//u)?.[1]);
  const fileName = path.split("/").at(-1) ?? path;
  return {
    provenance: {
      collection: "report",
      source: "github_annual_reports",
      providerReportId: `github:${path}`,
      canonicalUrl: `https://github.com/jacobdjwilson/awesome-annual-security-reports/blob/${commitSha}/${encodePath(path)}`,
      sourceIndexUrl:
        "https://github.com/jacobdjwilson/awesome-annual-security-reports",
      sourcePublishedAt: null,
      activityStartAt: null,
      activityEndAt: null,
      observedAt: observedAt.toISOString(),
      updatedAt: observedAt.toISOString(),
      reportYear: Number.isFinite(year) ? year : null,
      reportType: "annual_analysis",
    },
    title: fileName.replace(/\.pdf$/iu, "").replaceAll(/[_-]+/gu, " "),
    contentHash: null,
  };
}

async function fetchReportPages(
  source: string,
  endpoint: string,
  since: Date,
  fetchImpl: FetchImplementation,
  requestTimeoutMs: number,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<unknown[]> {
  const url = new URL(endpoint);
  url.searchParams.set("since", since.toISOString());
  const pages: unknown[] = [];
  const visited = new Set<string>();
  let nextUrl: string | URL | null = url;
  while (nextUrl) {
    const safeUrl = sameOriginUrl(nextUrl, endpoint, `${source} pagination`);
    const currentUrl = safeUrl.toString();
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);
    const payload = await fetchJson(
      source,
      safeUrl,
      fetchImpl,
      extraHeaders,
      requestTimeoutMs,
      signal,
    );
    pages.push(payload);
    nextUrl = getNextPageUrl(payload);
  }
  return pages;
}

async function fetchRostiReportPages(
  endpoint: string,
  since: Date,
  fetchImpl: FetchImplementation,
  apiKey: string,
  requestTimeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const pages: unknown[] = [];
  let cursor: string | null = null;
  const visited = new Set<string>();
  while (true) {
    const url = new URL(endpoint);
    url.searchParams.set("timestamp", since.toISOString());
    if (cursor) url.searchParams.set("cursor", cursor);
    const currentUrl = url.toString();
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);
    const payload = await fetchJson(
      "ROSTI",
      url,
      fetchImpl,
      { "X-Api-Key": apiKey },
      requestTimeoutMs,
      signal,
    );
    pages.push(payload);
    if (!isRecord(payload) || !isRecord(payload.meta)) break;
    if (payload.meta.has_more !== true) break;
    const nextCursor = stringValue(payload.meta.next_cursor);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return pages;
}

function getNextPageUrl(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.next === "string" && payload.next.trim() !== "") {
    return payload.next;
  }
  if (
    isRecord(payload.pagination) &&
    typeof payload.pagination.next === "string" &&
    payload.pagination.next.trim() !== ""
  ) {
    return payload.pagination.next;
  }
  return null;
}

async function fetchJson(
  source: string,
  input: string | URL,
  fetchImpl: FetchImplementation,
  extraHeaders: Record<string, string>,
  requestTimeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchWithTimeout(
    fetchImpl,
    input,
    {
      headers: { Accept: "application/json", ...extraHeaders },
      redirect: "manual",
    },
    requestTimeoutMs,
    source,
    signal,
  );
  if (!response.ok) throw new ReportApiError(source, response.status);
  const bytes = await readResponseBytes(response, maxReportJsonResponseBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`${source} response body was not valid JSON`);
  }
}

function sameOriginUrl(
  value: string | URL,
  endpoint: string,
  source: string,
): URL {
  const base = new URL(endpoint);
  const candidate = new URL(value, base);
  if (
    (candidate.protocol !== "http:" && candidate.protocol !== "https:") ||
    candidate.protocol !== base.protocol ||
    candidate.hostname !== base.hostname ||
    candidate.port !== base.port
  ) {
    throw new Error(`${source} URL is not allowed`);
  }
  return candidate;
}

async function fetchWithTimeout(
  fetchImpl: FetchImplementation,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  source: string,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${source} request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  source: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${source} request timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
        externalSignal?.addEventListener(
          "abort",
          () => reject(new Error(`${source} request aborted`)),
          { once: true },
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseReportItems(
  payload: unknown,
  source: "orkl" | "rosti",
  observedAt: Date,
): ReportCandidate[] {
  const items = isRecord(payload)
    ? Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.data)
        ? payload.data
        : null
    : Array.isArray(payload)
      ? payload
      : null;
  if (!items)
    throw new Error(`${source.toUpperCase()} response has no report list`);

  return items.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id) ?? stringValue(item.uuid);
    const title = stringValue(item.title) ?? stringValue(item.name);
    const url =
      stringValue(item.url) ??
      stringValue(item.report_url) ??
      stringValue(item.reference) ??
      (isRecord(item.files) ? stringValue(item.files.pdf) : null);
    if (!id || !title || !url) return [];
    const reportType = inferReportType(item.report_type ?? item.type, title);
    return [
      {
        provenance: {
          collection: "report" as const,
          source,
          providerReportId: id,
          canonicalUrl: url,
          sourcePublishedAt: parseReportTimestamp(
            stringValue(item.published_at) ??
              stringValue(item.published_date) ??
              stringValue(item.date) ??
              stringValue(item.file_creation_date),
          ),
          activityStartAt: parseReportTimestamp(
            stringValue(item.activity_start_at),
          ),
          activityEndAt: parseReportTimestamp(
            stringValue(item.activity_end_at),
          ),
          observedAt: observedAt.toISOString(),
          updatedAt: parseReportTimestamp(
            stringValue(item.updated_at) ?? stringValue(item.last_updated),
          ),
          reportYear:
            numberValue(item.report_year) ??
            yearFromTimestamp(stringValue(item.date)),
          reportType,
        },
        title,
        contentHash:
          stringValue(item.content_hash) ?? stringValue(item.sha1_hash),
        metadata: pickReportMetadata(item),
        contentPayload: {
          markdownText: stringValue(item.plain_text),
        },
      },
    ];
  });
}

function pickReportMetadata(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const keys = [
    "publisher",
    "author",
    "description",
    "abstract",
    "methodology",
    "sectors",
    "regions",
    "threat_actors",
    "campaigns",
    "malware",
    "ttps",
    "iocs",
    "yara_available",
    "attribution",
    "confidence",
    "edition",
    "metrics",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => item[key] !== undefined && item[key] !== null)
      .map((key) => [key, item[key]]),
  );
}

function deduplicateCandidates(
  candidates: ReportCandidate[],
): ReportCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.provenance.source}:${candidate.provenance.providerReportId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeGitHubStatus(value: unknown): GitHubReportChange["status"] {
  return value === "modified" || value === "removed" || value === "renamed"
    ? value
    : "added";
}

function parseReportType(value: unknown): ReportType {
  return value === "threat_intelligence" ||
    value === "annual_analysis" ||
    value === "survey" ||
    value === "research"
    ? value
    : "other";
}

function inferReportType(value: unknown, title: string): ReportType {
  const explicit = parseReportType(value);
  if (explicit !== "other") return explicit;

  const normalizedTitle = title.toLowerCase();
  if (
    normalizedTitle.includes("m-trends") ||
    /\bresearch\b|\bstudy\b|data,? insights|original findings/iu.test(
      normalizedTitle,
    )
  ) {
    return "research";
  }
  if (/\bsurvey\b|\bbenchmark\b|\bindex\b/iu.test(normalizedTitle)) {
    return "survey";
  }
  if (
    /\bannual\b|\byear in review\b|\bannual report\b/iu.test(normalizedTitle)
  ) {
    return "annual_analysis";
  }
  if (
    /\bmalware\b|\bransomware\b|\bphishing\b|\bthreat\b|\bloader\b|\bexploit\b|\bzero-day\b|\btactics,? techniques/iu.test(
      normalizedTitle,
    )
  ) {
    return "threat_intelligence";
  }
  return "other";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function yearFromTimestamp(value: string | null): number | null {
  if (!value) return null;
  const year = new Date(value).getUTCFullYear();
  return Number.isFinite(year) && year > 1900 ? year : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function markdownPathForPdf(path: string): string {
  const year = path.match(/^Annual Security Reports\/(\d{4})\//u)?.[1];
  const fileName = path
    .split("/")
    .at(-1)
    ?.replace(/\.pdf$/iu, ".md");
  return `Markdown Conversions/${year ?? "unknown"}/${fileName ?? "report.md"}`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

function htmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, "")
    .replace(/<style[\s\S]*?<\/style>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|h[1-6]|li|article|section)>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
