const youtubeApiBase = "https://www.googleapis.com/youtube/v3";

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type YouTubeVideo = {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  sourceUrl: string;
  publishedAt: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
};

export type YouTubeClientOptions = {
  fetchImpl?: FetchImplementation;
  endpoint?: string;
};

export type YouTubeDiscoveryResult = {
  videos: YouTubeVideo[];
  failures: Array<{ channelId: string; message: string }>;
};

export type YouTubeAgeFilterOptions = {
  now?: Date;
  ingestionWindowHours: number;
};

export class YouTubeApiError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(
      `YouTube request failed with status ${status}${message ? `: ${message}` : ""}`,
    );
    this.name = "YouTubeApiError";
    this.status = status;
  }
}

export class YouTubeResponseError extends Error {
  constructor(message: string) {
    super(`Invalid YouTube response: ${message}`);
    this.name = "YouTubeResponseError";
  }
}

type PlaylistPage = {
  uploadsPlaylistId: string;
  items: Array<{
    id: string;
    title: string;
    description: string;
    channelId: string;
    channelTitle: string;
    publishedAt: string;
    thumbnailUrl: string | null;
  }>;
  nextPageToken: string | null;
};

export class YouTubeClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string,
    options: YouTubeClientOptions = {},
  ) {
    if (apiKey.trim().length === 0) {
      throw new Error("YOUTUBE_API_KEY is required");
    }

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? youtubeApiBase;
  }

  async listChannelVideos(
    channelId: string,
    limit: number,
  ): Promise<YouTubeVideo[]> {
    if (channelId.trim().length === 0) {
      throw new Error("YouTube channel ID is required");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("YouTube video limit must be an integer from 1 to 100");
    }

    const playlistId = await this.resolveUploadsPlaylist(channelId);
    const items: PlaylistPage["items"] = [];
    let pageToken: string | undefined;

    while (items.length < limit) {
      const page = await this.fetchPlaylistPage(playlistId, pageToken);
      items.push(...page.items.slice(0, limit - items.length));
      pageToken = page.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    const uniqueItems = [
      ...new Map(items.map((item) => [item.id, item])).values(),
    ];
    return this.enrichVideos(uniqueItems);
  }

  private async resolveUploadsPlaylist(channelId: string): Promise<string> {
    const payload = await this.request("channels", {
      part: "contentDetails",
      id: channelId,
    });
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.items) ||
      payload.items.length === 0
    ) {
      throw new YouTubeResponseError("channel was not found");
    }

    const item = payload.items[0];
    if (
      !isRecord(item) ||
      !isRecord(item.contentDetails) ||
      !isRecord(item.contentDetails.relatedPlaylists)
    ) {
      throw new YouTubeResponseError("channel uploads playlist was missing");
    }

    return requiredString(
      item.contentDetails.relatedPlaylists.uploads,
      "channel uploads playlist",
    );
  }

  private async fetchPlaylistPage(
    playlistId: string,
    pageToken?: string,
  ): Promise<PlaylistPage> {
    const payload = await this.request("playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw new YouTubeResponseError("playlist items were missing");
    }

    const items = payload.items.map((item, index) =>
      parsePlaylistItem(item, index),
    );
    return {
      uploadsPlaylistId: playlistId,
      items,
      nextPageToken: optionalString(payload.nextPageToken, "nextPageToken"),
    };
  }

  private async enrichVideos(
    items: PlaylistPage["items"],
  ): Promise<YouTubeVideo[]> {
    if (items.length === 0) return [];

    const payload = await this.request("videos", {
      part: "contentDetails,snippet",
      id: items.map((item) => item.id).join(","),
    });
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw new YouTubeResponseError("video details were missing");
    }

    const details = new Map<string, Record<string, unknown>>();
    payload.items.forEach((item, index) => {
      if (!isRecord(item)) {
        throw new YouTubeResponseError(
          `video detail ${index} must be an object`,
        );
      }
      const id = requiredString(item.id, `video detail ${index}.id`);
      details.set(id, item);
    });

    return items.map((item) => {
      const detail = details.get(item.id);
      const contentDetails =
        detail && isRecord(detail.contentDetails)
          ? detail.contentDetails
          : undefined;
      const duration = optionalString(
        contentDetails?.duration,
        `video ${item.id}.duration`,
      );
      return {
        id: item.id,
        title: item.title,
        description: item.description,
        channelId: item.channelId,
        channelTitle: item.channelTitle,
        sourceUrl: `https://www.youtube.com/watch?v=${item.id}`,
        publishedAt: item.publishedAt,
        durationSeconds: duration ? parseIsoDuration(duration) : null,
        thumbnailUrl: item.thumbnailUrl,
      };
    });
  }

  private async request(
    resource: string,
    parameters: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${this.endpoint}/${resource}`);
    url.searchParams.set("key", this.apiKey);
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new YouTubeResponseError("response body was not valid JSON");
    }
    if (!response.ok) {
      throw new YouTubeApiError(response.status, readApiError(payload));
    }
    return payload;
  }
}

export async function discoverYouTubeVideos(
  client: YouTubeClient,
  channelIds: string[],
  maxVideosPerSync: number,
): Promise<YouTubeDiscoveryResult> {
  if (!Number.isInteger(maxVideosPerSync) || maxVideosPerSync < 1) {
    throw new Error("maxVideosPerSync must be a positive integer");
  }

  const videos: YouTubeVideo[] = [];
  const failures: YouTubeDiscoveryResult["failures"] = [];
  let remaining = maxVideosPerSync;

  for (const channelId of channelIds) {
    if (remaining === 0) break;
    try {
      const channelVideos = await client.listChannelVideos(
        channelId,
        remaining,
      );
      const newVideos = channelVideos.filter(
        (video) => !videos.some((existing) => existing.id === video.id),
      );
      videos.push(...newVideos);
      remaining -= newVideos.length;
    } catch (error) {
      failures.push({
        channelId,
        message: safeErrorMessage(error),
      });
    }
  }

  return { videos, failures };
}

export function filterYouTubeVideosByAge(
  videos: YouTubeVideo[],
  options: YouTubeAgeFilterOptions,
): YouTubeVideo[] {
  const now = options.now ?? new Date();
  if (
    !Number.isFinite(options.ingestionWindowHours) ||
    options.ingestionWindowHours <= 0
  ) {
    throw new Error("YouTube ingestion window must be a positive number");
  }

  const windowStart =
    now.getTime() - options.ingestionWindowHours * 60 * 60 * 1000;
  return videos.filter((video) => {
    const publishedAt = Date.parse(video.publishedAt);
    return (
      !Number.isNaN(publishedAt) &&
      publishedAt <= now.getTime() &&
      publishedAt >= windowStart
    );
  });
}

export function createYouTubeClientFromEnv(
  options: YouTubeClientOptions = {},
): YouTubeClient {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is required");
  return new YouTubeClient(apiKey, options);
}

function parsePlaylistItem(
  value: unknown,
  index: number,
): PlaylistPage["items"][number] {
  if (
    !isRecord(value) ||
    !isRecord(value.snippet) ||
    !isRecord(value.contentDetails)
  ) {
    throw new YouTubeResponseError(`playlist item ${index} was malformed`);
  }
  return {
    id: requiredString(
      value.contentDetails.videoId,
      `playlist item ${index}.videoId`,
    ),
    title: requiredString(value.snippet.title, `playlist item ${index}.title`),
    description: requiredString(
      value.snippet.description,
      `playlist item ${index}.description`,
    ),
    channelId: requiredString(
      value.snippet.channelId,
      `playlist item ${index}.channelId`,
    ),
    channelTitle: requiredString(
      value.snippet.channelTitle,
      `playlist item ${index}.channelTitle`,
    ),
    publishedAt: requiredString(
      value.contentDetails.videoPublishedAt ?? value.snippet.publishedAt,
      `playlist item ${index}.publishedAt`,
    ),
    thumbnailUrl: readThumbnail(
      value.snippet.thumbnails,
      `playlist item ${index}.thumbnails`,
    ),
  };
}

function parseIsoDuration(value: string): number {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) throw new YouTubeResponseError(`invalid ISO duration '${value}'`);
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0)
  );
}

function readThumbnail(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value))
    throw new YouTubeResponseError(`${field} must be an object`);
  for (const name of ["maxres", "standard", "high", "medium", "default"]) {
    const thumbnail = value[name];
    if (isRecord(thumbnail) && typeof thumbnail.url === "string")
      return thumbnail.url;
  }
  return null;
}

function readApiError(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return typeof payload.error.message === "string"
    ? payload.error.message.slice(0, 300)
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new YouTubeResponseError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new YouTubeResponseError(`${field} must be a string or null`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown YouTube error";
}
