import { readFile } from "node:fs/promises";

export type YouTubeSourceConfig = {
  enabled: boolean;
  channelIds: string[];
  maxVideosPerSync: number;
  transcriptProvider: string;
};

export type MediastackSourceConfig = {
  enabled: boolean;
  apiKeyEnv: string;
  keywords: string[];
  cadenceHours: number;
  queryWindowHours: number;
  monthlyQueryAllowance: number;
  queryIntervalSeconds: number;
};

export type ReportsSourceConfig = {
  enabled: boolean;
  cadenceHours: number;
  queryWindowHours: number;
  maxDetailFetches: number;
  requestTimeoutMs: number;
  maxRunDurationMs: number;
  processingConcurrency: number;
  rostiApiKeyEnv: string;
  orklEndpoint: string;
  rostiEndpoint: string;
  githubOwner: string;
  githubRepository: string;
};

export type RedditSourceConfig = {
  enabled: boolean;
  subreddits: string[];
  cadenceHours: number;
  queryWindowHours: number;
  maxItemsPerPoll: number;
  maxDetailFetches: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
};

export type CveSourceConfig = {
  enabled: boolean;
  endpoint: string;
  cadenceHours: number;
  queryWindowHours: number;
  retentionDays: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
};

export type GitHubTrendingSourceConfig = {
  enabled: boolean;
  endpoint: string;
  cadenceHours: number;
  maxItemsPerPoll: number;
  maxDetailFetches: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
};

export type LocalConfig = {
  ingestionWindowHours: number;
  polling: {
    intervalHours: number;
  };
  youtube: YouTubeSourceConfig;
  mediastack: MediastackSourceConfig;
  reports: ReportsSourceConfig;
  reddit: RedditSourceConfig;
  cves: CveSourceConfig;
  githubTrending: GitHubTrendingSourceConfig;
};

type ParsedConfig = {
  ingestion?: {
    window_hours?: unknown;
  };
  polling?: {
    interval_hours?: unknown;
  };
  sources?: {
    youtube?: {
      enabled?: unknown;
      channel_ids?: unknown;
      max_videos_per_sync?: unknown;
      transcript_provider?: unknown;
    };
    mediastack?: ParsedMediastackConfig;
    reports?: ParsedReportsConfig;
    reddit?: ParsedRedditConfig;
    cves?: ParsedCveConfig;
    github_trending?: ParsedGitHubTrendingConfig;
  };
};

type ParsedMediastackConfig = {
  enabled?: unknown;
  api_key_env?: unknown;
  keywords?: unknown;
  cadence_hours?: unknown;
  query_window_hours?: unknown;
  monthly_query_allowance?: unknown;
  query_interval_seconds?: unknown;
};

type ParsedReportsConfig = {
  enabled?: unknown;
  cadence_hours?: unknown;
  query_window_hours?: unknown;
  max_detail_fetches?: unknown;
  request_timeout_ms?: unknown;
  max_run_duration_ms?: unknown;
  processing_concurrency?: unknown;
  rosti_api_key_env?: unknown;
  orkl_endpoint?: unknown;
  rosti_endpoint?: unknown;
  github_owner?: unknown;
  github_repository?: unknown;
};

type ParsedRedditConfig = {
  enabled?: unknown;
  subreddits?: unknown;
  cadence_hours?: unknown;
  query_window_hours?: unknown;
  max_items_per_poll?: unknown;
  max_detail_fetches?: unknown;
  request_timeout_ms?: unknown;
  max_response_bytes?: unknown;
};

type ParsedCveConfig = {
  enabled?: unknown;
  endpoint?: unknown;
  cadence_hours?: unknown;
  query_window_hours?: unknown;
  retention_days?: unknown;
  request_timeout_ms?: unknown;
  max_response_bytes?: unknown;
};

type ParsedGitHubTrendingConfig = {
  enabled?: unknown;
  endpoint?: unknown;
  cadence_hours?: unknown;
  max_items_per_poll?: unknown;
  max_detail_fetches?: unknown;
  request_timeout_ms?: unknown;
  max_response_bytes?: unknown;
};

export async function loadLocalConfig(
  path = new URL("../config.toml", import.meta.url),
): Promise<LocalConfig> {
  const contents = await readFile(path, "utf8");
  const raw = Bun.TOML.parse(contents) as ParsedConfig;
  const configuredMediaStackEnv = raw.sources?.mediastack?.api_key_env;
  const mediaStackEnvName =
    typeof configuredMediaStackEnv === "string"
      ? configuredMediaStackEnv
      : "MEDIASTACK_API_KEY";
  const configuredRostiEnv = raw.sources?.reports?.rosti_api_key_env;
  const rostiEnvName =
    typeof configuredRostiEnv === "string"
      ? configuredRostiEnv
      : "ROSTI_API_KEY";
  return parseLocalConfig(
    contents,
    process.env.YOUTUBE_API_KEY,
    process.env[mediaStackEnvName],
    process.env[rostiEnvName],
  );
}

export function parseLocalConfig(
  contents: string,
  youtubeApiKey?: string,
  mediastackApiKey?: string,
  rostiApiKey?: string,
): LocalConfig {
  let parsed: ParsedConfig;
  try {
    parsed = Bun.TOML.parse(contents) as ParsedConfig;
  } catch (error) {
    throw new Error(
      `Configuration file is not valid TOML: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  const ingestionWindowHours = parsed.ingestion?.window_hours ?? 12;
  if (
    typeof ingestionWindowHours !== "number" ||
    !Number.isFinite(ingestionWindowHours) ||
    ingestionWindowHours <= 0
  ) {
    throw new Error("ingestion.window_hours must be a positive number");
  }

  const pollingIntervalHours = readBoundedNumber(
    parsed.polling?.interval_hours ?? 1,
    "polling.interval_hours",
    0.25,
    168,
  );

  const source = parsed.sources?.youtube;
  const enabled = source?.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new Error("sources.youtube.enabled must be a boolean");
  }

  const channelIds = source?.channel_ids ?? [];
  if (
    !Array.isArray(channelIds) ||
    channelIds.some(
      (channelId) => typeof channelId !== "string" || channelId.trim() === "",
    )
  ) {
    throw new Error("sources.youtube.channel_ids must be non-empty strings");
  }

  const maxVideosPerSync = source?.max_videos_per_sync ?? 20;
  if (
    typeof maxVideosPerSync !== "number" ||
    !Number.isInteger(maxVideosPerSync) ||
    maxVideosPerSync < 1 ||
    maxVideosPerSync > 100
  ) {
    throw new Error(
      "sources.youtube.max_videos_per_sync must be an integer from 1 to 100",
    );
  }

  const transcriptProvider = source?.transcript_provider ?? "yt-dlp";
  if (
    typeof transcriptProvider !== "string" ||
    transcriptProvider.trim() === ""
  ) {
    throw new Error(
      "sources.youtube.transcript_provider must be a non-empty string",
    );
  }

  if (enabled && (!youtubeApiKey || youtubeApiKey.trim() === "")) {
    throw new Error(
      "YOUTUBE_API_KEY is required when YouTube collection is enabled",
    );
  }

  const mediastack = parseMediastackConfig(
    parsed.sources?.mediastack,
    mediastackApiKey,
  );
  const reports = parseReportsConfig(parsed.sources?.reports, rostiApiKey);
  const reddit = parseRedditConfig(parsed.sources?.reddit);
  const cves = parseCveConfig(parsed.sources?.cves);
  const githubTrending = parseGitHubTrendingConfig(
    parsed.sources?.github_trending,
  );

  return {
    ingestionWindowHours,
    polling: { intervalHours: pollingIntervalHours },
    youtube: {
      enabled,
      channelIds: channelIds.map((channelId) => channelId.trim()),
      maxVideosPerSync,
      transcriptProvider: transcriptProvider.trim(),
    },
    mediastack,
    reports,
    reddit,
    cves,
    githubTrending,
  };
}

function parseGitHubTrendingConfig(
  source: ParsedGitHubTrendingConfig | undefined,
): GitHubTrendingSourceConfig {
  const enabled = source?.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new Error("sources.github_trending.enabled must be a boolean");
  }
  return {
    enabled,
    endpoint: readEndpoint(
      source?.endpoint,
      "https://github.com/trending?since=daily",
    ),
    cadenceHours: readBoundedNumber(
      source?.cadence_hours ?? 6,
      "sources.github_trending.cadence_hours",
      0.25,
      168,
    ),
    maxItemsPerPoll: readBoundedInteger(
      source?.max_items_per_poll ?? 25,
      "sources.github_trending.max_items_per_poll",
      1,
      100,
    ),
    maxDetailFetches: readBoundedInteger(
      source?.max_detail_fetches ?? 25,
      "sources.github_trending.max_detail_fetches",
      1,
      100,
    ),
    requestTimeoutMs: readBoundedInteger(
      source?.request_timeout_ms ?? 20_000,
      "sources.github_trending.request_timeout_ms",
      1_000,
      120_000,
    ),
    maxResponseBytes: readBoundedInteger(
      source?.max_response_bytes ?? 10_000_000,
      "sources.github_trending.max_response_bytes",
      100_000,
      50_000_000,
    ),
  };
}

function parseCveConfig(source: ParsedCveConfig | undefined): CveSourceConfig {
  const enabled = source?.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new Error("sources.cves.enabled must be a boolean");
  }
  return {
    enabled,
    endpoint: readEndpoint(
      source?.endpoint,
      "https://cve.circl.lu/api/vulnerability/recent",
    ),
    cadenceHours: readBoundedNumber(
      source?.cadence_hours ?? 6,
      "sources.cves.cadence_hours",
      0.25,
      168,
    ),
    queryWindowHours: readBoundedNumber(
      source?.query_window_hours ?? 24,
      "sources.cves.query_window_hours",
      1,
      720,
    ),
    retentionDays: readBoundedInteger(
      source?.retention_days ?? 7,
      "sources.cves.retention_days",
      1,
      365,
    ),
    requestTimeoutMs: readBoundedInteger(
      source?.request_timeout_ms ?? 30_000,
      "sources.cves.request_timeout_ms",
      1_000,
      120_000,
    ),
    maxResponseBytes: readBoundedInteger(
      source?.max_response_bytes ?? 20_000_000,
      "sources.cves.max_response_bytes",
      100_000,
      50_000_000,
    ),
  };
}

function parseRedditConfig(
  source: ParsedRedditConfig | undefined,
): RedditSourceConfig {
  const enabled = source?.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new Error("sources.reddit.enabled must be a boolean");
  }
  const subreddits = source?.subreddits ?? ["blueteamsec"];
  if (
    !Array.isArray(subreddits) ||
    subreddits.length > 50 ||
    subreddits.some(
      (subreddit) =>
        typeof subreddit !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_]{2,20}$/u.test(subreddit.trim()),
    )
  ) {
    throw new Error(
      "sources.reddit.subreddits must contain 3 to 21 character Reddit names",
    );
  }
  const normalizedSubreddits = subreddits.map((subreddit) => subreddit.trim());
  if (
    new Set(normalizedSubreddits.map((subreddit) => subreddit.toLowerCase()))
      .size !== normalizedSubreddits.length
  ) {
    throw new Error("sources.reddit.subreddits must not contain duplicates");
  }
  return {
    enabled,
    subreddits: normalizedSubreddits,
    cadenceHours: readBoundedNumber(
      source?.cadence_hours ?? 1,
      "sources.reddit.cadence_hours",
      0.25,
      168,
    ),
    queryWindowHours: readBoundedNumber(
      source?.query_window_hours ?? 12,
      "sources.reddit.query_window_hours",
      1,
      168,
    ),
    maxItemsPerPoll: readBoundedInteger(
      source?.max_items_per_poll ?? 50,
      "sources.reddit.max_items_per_poll",
      1,
      200,
    ),
    maxDetailFetches: readBoundedInteger(
      source?.max_detail_fetches ?? 25,
      "sources.reddit.max_detail_fetches",
      1,
      200,
    ),
    requestTimeoutMs: readBoundedInteger(
      source?.request_timeout_ms ?? 15_000,
      "sources.reddit.request_timeout_ms",
      1_000,
      120_000,
    ),
    maxResponseBytes: readBoundedInteger(
      source?.max_response_bytes ?? 2_000_000,
      "sources.reddit.max_response_bytes",
      100_000,
      20_000_000,
    ),
  };
}

function parseReportsConfig(
  source: ParsedReportsConfig | undefined,
  rostiApiKey?: string,
): ReportsSourceConfig {
  const enabled = source?.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new Error("sources.reports.enabled must be a boolean");
  }
  const rostiApiKeyEnv = source?.rosti_api_key_env ?? "ROSTI_API_KEY";
  if (
    typeof rostiApiKeyEnv !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/u.test(rostiApiKeyEnv.trim())
  ) {
    throw new Error(
      "sources.reports.rosti_api_key_env must be an uppercase environment variable name",
    );
  }
  if (enabled && (!rostiApiKey || rostiApiKey.trim() === "")) {
    throw new Error(
      `${rostiApiKeyEnv.trim()} is required when report collection is enabled`,
    );
  }
  return {
    enabled,
    cadenceHours: readBoundedNumber(
      source?.cadence_hours ?? 24,
      "sources.reports.cadence_hours",
      1,
      168,
    ),
    queryWindowHours: readBoundedNumber(
      source?.query_window_hours ?? 48,
      "sources.reports.query_window_hours",
      1,
      168,
    ),
    maxDetailFetches: readBoundedInteger(
      source?.max_detail_fetches ?? 100,
      "sources.reports.max_detail_fetches",
      1,
      1000,
    ),
    requestTimeoutMs: readBoundedInteger(
      source?.request_timeout_ms ?? 30_000,
      "sources.reports.request_timeout_ms",
      1_000,
      120_000,
    ),
    maxRunDurationMs: readBoundedInteger(
      source?.max_run_duration_ms ?? 600_000,
      "sources.reports.max_run_duration_ms",
      60_000,
      3_600_000,
    ),
    processingConcurrency: readBoundedInteger(
      source?.processing_concurrency ?? 4,
      "sources.reports.processing_concurrency",
      1,
      10,
    ),
    rostiApiKeyEnv: rostiApiKeyEnv.trim(),
    orklEndpoint: readEndpoint(
      source?.orkl_endpoint,
      "https://orkl.eu/api/v1/library/entries",
    ),
    rostiEndpoint: readEndpoint(
      source?.rosti_endpoint,
      "https://api.rosti.dev/v2/reports",
    ),
    githubOwner: readNonEmptyString(
      source?.github_owner,
      "jacobdjwilson",
      "sources.reports.github_owner",
    ),
    githubRepository: readNonEmptyString(
      source?.github_repository,
      "awesome-annual-security-reports",
      "sources.reports.github_repository",
    ),
  };
}

function parseMediastackConfig(
  source: ParsedMediastackConfig | undefined,
  apiKey?: string,
): MediastackSourceConfig {
  const config = source;
  const enabled = config?.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new Error("sources.mediastack.enabled must be a boolean");
  }

  const apiKeyEnv = config?.api_key_env ?? "MEDIASTACK_API_KEY";
  if (
    typeof apiKeyEnv !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/u.test(apiKeyEnv.trim())
  ) {
    throw new Error(
      "sources.mediastack.api_key_env must be an uppercase environment variable name",
    );
  }

  const keywords = config?.keywords ?? [];
  if (
    !Array.isArray(keywords) ||
    keywords.length > 50 ||
    keywords.some(
      (keyword) => typeof keyword !== "string" || keyword.trim() === "",
    )
  ) {
    throw new Error(
      "sources.mediastack.keywords must contain 1 to 50 non-empty strings",
    );
  }
  const normalizedKeywords = keywords.map((keyword) => keyword.trim());
  if (
    new Set(normalizedKeywords.map((keyword) => keyword.toLowerCase())).size !==
    normalizedKeywords.length
  ) {
    throw new Error("sources.mediastack.keywords must not contain duplicates");
  }

  const cadenceHours = readBoundedNumber(
    config?.cadence_hours ?? 24,
    "sources.mediastack.cadence_hours",
    0.25,
    168,
  );
  const queryWindowHours = readBoundedNumber(
    config?.query_window_hours ?? 12,
    "sources.mediastack.query_window_hours",
    0.25,
    168,
  );
  const monthlyQueryAllowance = readBoundedInteger(
    config?.monthly_query_allowance ?? 100,
    "sources.mediastack.monthly_query_allowance",
    1,
    100_000,
  );
  const queryIntervalSeconds = readBoundedNumber(
    config?.query_interval_seconds ?? 2,
    "sources.mediastack.query_interval_seconds",
    0,
    3_600,
  );

  if (enabled && (!apiKey || apiKey.trim() === "")) {
    throw new Error(
      `${apiKeyEnv.trim()} is required when Mediastack is enabled`,
    );
  }

  return {
    enabled,
    apiKeyEnv: apiKeyEnv.trim(),
    keywords: normalizedKeywords,
    cadenceHours,
    queryWindowHours,
    monthlyQueryAllowance,
    queryIntervalSeconds,
  };
}

function readBoundedNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function readBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  return readBoundedNumber(value, field, minimum, maximum);
}

function readNonEmptyString(
  value: unknown,
  fallback: string,
  field: string,
): string {
  const result = value ?? fallback;
  if (typeof result !== "string" || result.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return result.trim();
}

function readEndpoint(value: unknown, fallback: string): string {
  const endpoint = readNonEmptyString(value, fallback, "report endpoint");
  try {
    new URL(endpoint);
  } catch {
    throw new Error("report endpoint must be a valid URL");
  }
  return endpoint;
}
