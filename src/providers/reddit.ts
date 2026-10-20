import { assertSafePublicUrl } from "../utils/safe-url";

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RedditNewsItem = {
  id: string;
  subreddit: string;
  title: string;
  source: string | null;
  url: string;
  redditUrl: string;
  description: string | null;
  publishedAt: string | null;
  author: string | null;
  keyword: string;
  imageUrl: string | null;
  language: string | null;
  country: string | null;
  category: string | null;
};

export type RedditPollResult = {
  items: RedditNewsItem[];
  entriesFound: number;
  articleFetches: number;
  skipped: number;
  failures: string[];
};

export type RedditDiagnostics = Omit<RedditPollResult, "items"> & {
  itemsFound: number;
  lastRunAt: string | null;
  durationMs: number | null;
};

export type RedditClientOptions = {
  fetchImpl?: FetchImplementation;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxItemsPerPoll?: number;
  maxDetailFetches?: number;
  userAgent?: string;
};

const defaultUserAgent = "Aperture Intelligence Feed/1.0 (personal research)";

export class RedditClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxItemsPerPoll: number;
  private readonly maxDetailFetches: number;
  private readonly userAgent: string;
  private diagnostics: RedditDiagnostics = emptyDiagnostics();

  constructor(options: RedditClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    this.maxItemsPerPoll = options.maxItemsPerPoll ?? 50;
    this.maxDetailFetches = options.maxDetailFetches ?? 25;
    this.userAgent = options.userAgent ?? defaultUserAgent;
  }

  async poll(
    subreddits: string[],
    queryWindowHours: number,
    now = new Date(),
  ): Promise<RedditPollResult> {
    const started = performance.now();
    this.diagnostics.lastRunAt = now.toISOString();
    const result: RedditPollResult = {
      items: [],
      entriesFound: 0,
      articleFetches: 0,
      skipped: 0,
      failures: [],
    };
    const seenIds = new Set<string>();
    for (const subreddit of subreddits) {
      try {
        const xml = await this.fetchText(
          `https://www.reddit.com/r/${encodeURIComponent(subreddit)}.rss`,
          "application/atom+xml, application/xml, text/xml",
        );
        const entries = parseAtomEntries(xml, subreddit);
        result.entriesFound += entries.length;
        for (const entry of entries.slice(0, this.maxItemsPerPoll)) {
          if (
            seenIds.has(entry.id) ||
            !isWithinWindow(entry, now, queryWindowHours)
          ) {
            result.skipped += 1;
            continue;
          }
          seenIds.add(entry.id);
          const externalUrl = extractExternalLink(
            entry.content,
            entry.redditUrl,
          );
          if (!externalUrl) {
            const text = htmlToText(entry.content);
            if (wordCount(text) < 20) {
              result.skipped += 1;
              continue;
            }
            result.items.push({
              ...entry,
              url: entry.redditUrl,
              source: `Reddit r/${subreddit}`,
              description: text,
              keyword: subreddit,
              imageUrl: null,
              language: "en",
              country: null,
              category: "news",
            });
            continue;
          }
          if (result.articleFetches >= this.maxDetailFetches) {
            result.skipped += 1;
            continue;
          }
          result.articleFetches += 1;
          try {
            const article = await this.fetchText(
              externalUrl,
              "text/html, text/plain, application/xhtml+xml",
            );
            const text = htmlToText(article);
            if (wordCount(text) < 20) {
              result.skipped += 1;
              continue;
            }
            result.items.push({
              ...entry,
              url: externalUrl,
              source: hostnameOf(externalUrl),
              description: text,
              keyword: subreddit,
              imageUrl: null,
              language: "en",
              country: null,
              category: "news",
            });
          } catch (error) {
            result.skipped += 1;
            result.failures.push(
              `${entry.id}: ${error instanceof Error ? error.message : "article fetch failed"}`,
            );
          }
        }
      } catch (error) {
        result.failures.push(
          `r/${subreddit}: ${error instanceof Error ? error.message : "feed fetch failed"}`,
        );
      }
    }
    this.diagnostics = {
      entriesFound: result.entriesFound,
      articleFetches: result.articleFetches,
      skipped: result.skipped,
      failures: [...result.failures],
      itemsFound: result.items.length,
      lastRunAt: now.toISOString(),
      durationMs: Math.round(performance.now() - started),
    };
    return result;
  }

  getDiagnostics(): RedditDiagnostics {
    return {
      ...this.diagnostics,
      failures: [...this.diagnostics.failures],
    };
  }

  canPoll(now: Date, cadenceHours: number): boolean {
    if (!Number.isFinite(cadenceHours) || cadenceHours <= 0) {
      throw new Error("Reddit cadence must be positive");
    }
    if (!this.diagnostics.lastRunAt) return true;
    return (
      now.getTime() - Date.parse(this.diagnostics.lastRunAt) >=
      cadenceHours * 3_600_000
    );
  }

  private async fetchText(url: string, accept: string): Promise<string> {
    assertSafePublicUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: accept, "User-Agent": this.userAgent },
      });
      if (!response.ok) {
        throw new Error(`request failed with status ${response.status}`);
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > this.maxResponseBytes) {
        throw new Error("response exceeded configured size limit");
      }
      return new TextDecoder().decode(buffer);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseAtomEntries(xml: string, subreddit: string): ParsedEntry[] {
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/giu)].flatMap(
    (match) => {
      const body = match[1] ?? "";
      const id = textTag(body, "id");
      const title = textTag(body, "title");
      const redditUrl = linkTag(body, "alternate") ?? linkTag(body);
      if (!id || !title || !redditUrl) return [];
      return [
        {
          id: id.replace(/^t3_/u, ""),
          subreddit,
          title,
          source: null,
          url: redditUrl,
          redditUrl,
          description: null,
          publishedAt: textTag(body, "published") ?? textTag(body, "updated"),
          author: textTag(body, "name"),
          content: textTag(body, "content") ?? "",
          keyword: subreddit,
          imageUrl: null,
          language: "en",
          country: null,
          category: "news",
        },
      ];
    },
  );
}

type ParsedEntry = RedditNewsItem & { content: string };

function textTag(value: string, tag: string): string | null {
  const match = value.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "iu"),
  );
  return match?.[1] ? decodeXml(match[1]).trim() : null;
}

function linkTag(value: string, rel?: string): string | null {
  const pattern = rel
    ? new RegExp(`<link\\b[^>]*rel=["']${rel}["'][^>]*>`, "iu")
    : /<link\b[^>]*>/iu;
  const match = value.match(pattern);
  const href = match?.[0].match(/href=["']([^"']+)["']/iu)?.[1];
  return href ? decodeXml(href) : null;
}

function extractExternalLink(
  content: string,
  redditUrl: string,
): string | null {
  for (const match of content.matchAll(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>/giu,
  )) {
    const url = decodeXml(match[1] ?? "");
    if (url === redditUrl || isRedditUrl(url)) continue;
    try {
      assertSafePublicUrl(url);
      return url;
    } catch {
      continue;
    }
  }
  return null;
}

function isWithinWindow(
  entry: ParsedEntry,
  now: Date,
  queryWindowHours: number,
): boolean {
  if (!Number.isFinite(queryWindowHours) || queryWindowHours <= 0) {
    throw new Error("Reddit query window must be positive");
  }
  const timestamp = entry.publishedAt
    ? Date.parse(entry.publishedAt)
    : Number.NaN;
  return (
    Number.isFinite(timestamp) &&
    timestamp >= now.getTime() - queryWindowHours * 3_600_000 &&
    timestamp <= now.getTime()
  );
}

function isRedditUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "reddit.com" || hostname.endsWith(".reddit.com");
  } catch {
    return true;
  }
}

function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function htmlToText(value: string): string {
  return decodeXml(value)
    .replace(/<script[\s\S]*?<\/script>/giu, "")
    .replace(/<style[\s\S]*?<\/style>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|h[1-6]|li|article|section)>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function wordCount(value: string): number {
  return value.split(/\s+/u).filter(Boolean).length;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&#(x[0-9a-f]+|\d+);/giu, (_, code: string) =>
      String.fromCodePoint(
        code.toLowerCase().startsWith("x")
          ? parseInt(code.slice(1), 16)
          : Number(code),
      ),
    )
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&nbsp;/giu, " ");
}

function emptyDiagnostics(): RedditDiagnostics {
  return {
    itemsFound: 0,
    entriesFound: 0,
    articleFetches: 0,
    skipped: 0,
    failures: [],
    lastRunAt: null,
    durationMs: null,
  };
}
