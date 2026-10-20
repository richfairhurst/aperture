import { describe, expect, it } from "vitest";
import {
  YouTubeApiError,
  YouTubeClient,
  YouTubeResponseError,
  discoverYouTubeVideos,
  filterYouTubeVideosByAge,
} from "../src/providers/youtube";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const playlistItem = (id: string, title = `Video ${id}`) => ({
  snippet: {
    title,
    description: `Description for ${id}`,
    channelId: "UC-channel",
    channelTitle: "Test channel",
    publishedAt: "2026-10-08T01:00:00Z",
    thumbnails: { high: { url: `https://img.youtube.com/${id}.jpg` } },
  },
  contentDetails: {
    videoId: id,
    videoPublishedAt: "2026-10-08T01:00:00Z",
  },
});

describe("YouTube client", () => {
  it("resolves uploads, follows pagination, and enriches stable video IDs", async () => {
    const requests: URL[] = [];
    const client = new YouTubeClient("secret-key", {
      endpoint: "https://youtube.test/v3",
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        requests.push(url);

        if (url.pathname.endsWith("/channels")) {
          return jsonResponse({
            items: [
              {
                contentDetails: { relatedPlaylists: { uploads: "UU-channel" } },
              },
            ],
          });
        }
        if (url.pathname.endsWith("/playlistItems")) {
          if (url.searchParams.get("pageToken") === "next") {
            return jsonResponse({ items: [playlistItem("video-2")] });
          }
          return jsonResponse({
            items: [playlistItem("video-1"), playlistItem("video-1")],
            nextPageToken: "next",
          });
        }
        return jsonResponse({
          items: [
            {
              id: "video-1",
              contentDetails: { duration: "PT1H2M3S" },
            },
            { id: "video-2", contentDetails: { duration: "PT45S" } },
          ],
        });
      },
    });

    const videos = await client.listChannelVideos("UC-channel", 3);

    expect(videos.map((video) => video.id)).toEqual(["video-1", "video-2"]);
    expect(videos[0]).toMatchObject({
      sourceUrl: "https://www.youtube.com/watch?v=video-1",
      durationSeconds: 3723,
      channelTitle: "Test channel",
      thumbnailUrl: "https://img.youtube.com/video-1.jpg",
    });
    expect(requests).toHaveLength(4);
    expect(requests[0]?.searchParams.get("key")).toBe("secret-key");
    expect(requests[1]?.searchParams.get("maxResults")).toBe("50");
    expect(requests[2]?.searchParams.get("pageToken")).toBe("next");
  });

  it("isolates a failed channel and deduplicates results across channels", async () => {
    const client = new YouTubeClient("secret-key", {
      fetchImpl: async (input) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/channels")) {
          if (url.searchParams.get("id") === "bad-channel") {
            return jsonResponse(
              { error: { message: "quota exceeded" } },
              { status: 403 },
            );
          }
          return jsonResponse({
            items: [
              { contentDetails: { relatedPlaylists: { uploads: "uploads" } } },
            ],
          });
        }
        if (url.pathname.endsWith("/playlistItems")) {
          return jsonResponse({ items: [playlistItem("same-video")] });
        }
        return jsonResponse({
          items: [{ id: "same-video", contentDetails: { duration: "PT10S" } }],
        });
      },
    });

    const result = await discoverYouTubeVideos(
      client,
      ["bad-channel", "good-channel", "another-channel"],
      5,
    );

    expect(result.videos.map((video) => video.id)).toEqual(["same-video"]);
    expect(result.failures).toEqual([
      {
        channelId: "bad-channel",
        message: "YouTube request failed with status 403: quota exceeded",
      },
    ]);
  });

  it("classifies API and malformed response failures safely", async () => {
    const apiFailure = new YouTubeClient("secret-key", {
      fetchImpl: async () =>
        jsonResponse(
          { error: { message: "too many requests" } },
          { status: 429 },
        ),
    });
    await expect(
      apiFailure.listChannelVideos("channel", 1),
    ).rejects.toMatchObject({
      constructor: YouTubeApiError,
      status: 429,
    });

    const malformed = new YouTubeClient("secret-key", {
      fetchImpl: async () => jsonResponse({ items: [{}] }),
    });
    await expect(
      malformed.listChannelVideos("channel", 1),
    ).rejects.toBeInstanceOf(YouTubeResponseError);
  });

  it("requires a key and valid limits", async () => {
    expect(() => new YouTubeClient("  ")).toThrow("YOUTUBE_API_KEY");
    await expect(
      new YouTubeClient("key").listChannelVideos("channel", 0),
    ).rejects.toThrow("video limit");
  });

  it("filters videos using the shared ingestion window", () => {
    const videos = [
      {
        id: "recent1",
        title: "Recent",
        description: "",
        channelId: "channel",
        channelTitle: "Channel",
        sourceUrl: "https://youtube.com/watch?v=recent1",
        publishedAt: "2026-10-08T11:00:00Z",
        durationSeconds: 10,
        thumbnailUrl: null,
      },
      {
        id: "oldvideo",
        title: "Old",
        description: "",
        channelId: "channel",
        channelTitle: "Channel",
        sourceUrl: "https://youtube.com/watch?v=oldvideo",
        publishedAt: "2026-10-07T10:59:59Z",
        durationSeconds: 10,
        thumbnailUrl: null,
      },
    ];

    expect(
      filterYouTubeVideosByAge(videos, {
        now: new Date("2026-10-08T12:00:00Z"),
        ingestionWindowHours: 24,
      }).map((video) => video.id),
    ).toEqual(["recent1"]);
  });
});
