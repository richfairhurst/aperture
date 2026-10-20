type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GitHubTrendingProject = {
  id: string;
  title: string;
  owner: string;
  repository: string;
  source: string;
  url: string;
  readmeUrl: string;
  description: string;
  content: string;
  publishedAt: string;
  author: string | null;
  keyword: string;
  imageUrl: string | null;
  language: string | null;
  country: string | null;
  category: string;
  trendingRank: number;
  stars: number | null;
  forks: number | null;
};

export type GitHubTrendingPollResult = {
  projects: GitHubTrendingProject[];
  repositoriesFound: number;
  readmesFetched: number;
  skipped: number;
  failures: string[];
};

export type GitHubTrendingDiagnostics = Omit<
  GitHubTrendingPollResult,
  "projects"
> & {
  projectsFound: number;
  lastRunAt: string | null;
  lastRunStatus: "completed" | "failed" | null;
  durationMs: number | null;
};

export class GitHubTrendingClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxItemsPerPoll: number;
  private readonly maxDetailFetches: number;
  private diagnostics: GitHubTrendingDiagnostics = emptyDiagnostics();

  constructor(options: {
    endpoint: string;
    fetchImpl?: FetchImplementation;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
    maxItemsPerPoll?: number;
    maxDetailFetches?: number;
  }) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 20_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 10_000_000;
    this.maxItemsPerPoll = options.maxItemsPerPoll ?? 25;
    this.maxDetailFetches = options.maxDetailFetches ?? 25;
  }

  canPoll(now: Date, cadenceHours: number): boolean {
    if (!Number.isFinite(cadenceHours) || cadenceHours <= 0) {
      throw new Error("GitHub Trending cadence must be positive");
    }
    if (!this.diagnostics.lastRunAt) return true;
    return (
      now.getTime() - Date.parse(this.diagnostics.lastRunAt) >=
      cadenceHours * 3_600_000
    );
  }

  async poll(now = new Date()): Promise<GitHubTrendingPollResult> {
    const started = performance.now();
    const result: GitHubTrendingPollResult = {
      projects: [],
      repositoriesFound: 0,
      readmesFetched: 0,
      skipped: 0,
      failures: [],
    };
    try {
      const html = await this.fetchText(this.endpoint, "text/html");
      const entries = parseTrendingEntries(html);
      result.repositoriesFound = entries.length;
      for (const entry of entries.slice(0, this.maxItemsPerPoll)) {
        if (result.readmesFetched >= this.maxDetailFetches) {
          result.skipped += 1;
          continue;
        }
        result.readmesFetched += 1;
        try {
          const readme = await this.fetchReadme(entry.owner, entry.repository);
          if (wordCount(readme.text) < 20) {
            result.skipped += 1;
            continue;
          }
          result.projects.push({
            ...entry,
            readmeUrl: readme.url,
            content: readme.text,
            publishedAt: now.toISOString(),
          });
        } catch (error) {
          result.skipped += 1;
          result.failures.push(
            `${entry.id}: ${error instanceof Error ? error.message : "README fetch failed"}`,
          );
        }
      }
      this.diagnostics = {
        repositoriesFound: result.repositoriesFound,
        projectsFound: result.projects.length,
        readmesFetched: result.readmesFetched,
        skipped: result.skipped,
        failures: [...result.failures],
        lastRunAt: now.toISOString(),
        lastRunStatus: "completed",
        durationMs: Math.round(performance.now() - started),
      };
      return result;
    } catch (error) {
      result.failures.push(
        error instanceof Error
          ? error.message
          : "GitHub Trending request failed",
      );
      this.diagnostics = {
        repositoriesFound: 0,
        projectsFound: 0,
        readmesFetched: 0,
        skipped: 0,
        failures: [...result.failures],
        lastRunAt: now.toISOString(),
        lastRunStatus: "failed",
        durationMs: Math.round(performance.now() - started),
      };
      return result;
    }
  }

  getDiagnostics(): GitHubTrendingDiagnostics {
    return { ...this.diagnostics, failures: [...this.diagnostics.failures] };
  }

  private async fetchReadme(
    owner: string,
    repository: string,
  ): Promise<{ url: string; text: string }> {
    for (const filename of ["README.md", "README.rst", "README"]) {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/HEAD/${filename}`;
      try {
        const text = await this.fetchText(url, "text/plain, text/markdown");
        return { url, text: markdownToText(text) };
      } catch (error) {
        if (error instanceof GitHubNotFoundError) continue;
        throw error;
      }
    }
    throw new Error("repository has no readable README");
  }

  private async fetchText(url: string, accept: string): Promise<string> {
    assertGitHubUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: accept,
          "User-Agent": "Aperture Intelligence Feed/1.0",
        },
      });
      if (response.status === 404) throw new GitHubNotFoundError();
      if (!response.ok)
        throw new Error(`GitHub request failed with status ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.maxResponseBytes)
        throw new Error("GitHub response exceeded configured size limit");
      return new TextDecoder().decode(bytes);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`GitHub request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class GitHubNotFoundError extends Error {}

type ParsedEntry = Omit<
  GitHubTrendingProject,
  "readmeUrl" | "content" | "publishedAt"
> & {
  path: string;
};

function parseTrendingEntries(html: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const articlePattern =
    /<article\b[^>]*class=["'][^"']*Box-row[^"']*["'][^>]*>([\s\S]*?)<\/article>/giu;
  for (const [index, match] of [...html.matchAll(articlePattern)].entries()) {
    const body = match[1] ?? "";
    const href = body.match(
      /<h2\b[\s\S]*?<a\b[^>]*href=["']\/(.+?)["'][^>]*>/iu,
    )?.[1];
    if (!href) continue;
    const parts = href.split("/").filter(Boolean);
    if (parts.length !== 2) continue;
    const owner = decodeHtml(parts[0] ?? "");
    const repository = decodeHtml(parts[1] ?? "");
    if (
      !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
      !/^[A-Za-z0-9_.-]+$/u.test(repository)
    )
      continue;
    const description = stripHtml(
      body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/iu)?.[1] ?? "",
    );
    const language = body.match(
      /itemprop=["']programmingLanguage["'][^>]*>([\s\S]*?)<\/[^>]+>/iu,
    )?.[1];
    const stars = parseCount(body.match(/([\d,]+)\s+stars today/iu)?.[1]);
    const forks = parseCount(
      body.match(
        /href=["'][^"']+\/forks["'][^>]*>[\s\S]*?([\d,]+)<\/a>/iu,
      )?.[1],
    );
    entries.push({
      id: `${owner}/${repository}`,
      title: `${owner} / ${repository}`,
      owner,
      repository,
      source: "GitHub Trending",
      url: `https://github.com/${owner}/${repository}`,
      description,
      author: owner,
      keyword: "github-trending",
      imageUrl: null,
      language: language ? stripHtml(language) : null,
      country: null,
      category: "github_project",
      trendingRank: index + 1,
      stars,
      forks,
      path: href,
    });
  }
  return entries;
}

function markdownToText(value: string): string {
  return value
    .replace(/```([\s\S]*?)```/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "• ")
    .replace(/<[^>]+>/gu, "")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<[^>]+>/gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/giu, (_, code: string) =>
      String.fromCodePoint(
        code.toLowerCase().startsWith("x")
          ? parseInt(code.slice(1), 16)
          : Number(code),
      ),
    )
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function parseCount(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function wordCount(value: string): number {
  return value.split(/\s+/u).filter(Boolean).length;
}

function assertGitHubUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["github.com", "raw.githubusercontent.com"].includes(url.hostname)
  ) {
    throw new Error("only public GitHub HTTPS URLs are allowed");
  }
}

function emptyDiagnostics(): GitHubTrendingDiagnostics {
  return {
    repositoriesFound: 0,
    projectsFound: 0,
    readmesFetched: 0,
    skipped: 0,
    failures: [],
    lastRunAt: null,
    lastRunStatus: null,
    durationMs: null,
  };
}
