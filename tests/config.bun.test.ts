import { describe, expect, it } from "bun:test";
import { parseLocalConfig } from "../src/config";

const validConfig = `
[sources.mediastack]
enabled = true
api_key_env = "MEDIASTACK_API_KEY"
keywords = ["China", "Iran", "Russia", "cybersecurity", "geopolitics", "artificial intelligence"]
cadence_hours = 24
query_window_hours = 12
monthly_query_allowance = 100
query_interval_seconds = 2

[sources.youtube]
enabled = true
channel_ids = ["UCdWIQh9DGG6uhJk8eyIFl1w"]
max_videos_per_sync = 20
transcript_provider = "yt-dlp"

[polling]
interval_hours = 1
`;

describe("local source configuration", () => {
  it("parses enabled YouTube configuration without storing the key", () => {
    expect(
      parseLocalConfig(validConfig, "configured-secret", "mediastack-secret"),
    ).toEqual({
      ingestionWindowHours: 12,
      polling: { intervalHours: 1 },
      youtube: {
        enabled: true,
        channelIds: ["UCdWIQh9DGG6uhJk8eyIFl1w"],
        maxVideosPerSync: 20,
        transcriptProvider: "yt-dlp",
      },
      mediastack: {
        enabled: true,
        apiKeyEnv: "MEDIASTACK_API_KEY",
        keywords: [
          "China",
          "Iran",
          "Russia",
          "cybersecurity",
          "geopolitics",
          "artificial intelligence",
        ],
        cadenceHours: 24,
        queryWindowHours: 12,
        monthlyQueryAllowance: 100,
        queryIntervalSeconds: 2,
      },
      reports: {
        enabled: false,
        cadenceHours: 24,
        queryWindowHours: 48,
        maxDetailFetches: 100,
        requestTimeoutMs: 30000,
        maxRunDurationMs: 600000,
        processingConcurrency: 4,
        rostiApiKeyEnv: "ROSTI_API_KEY",
        orklEndpoint: "https://orkl.eu/api/v1/library/entries",
        rostiEndpoint: "https://api.rosti.dev/v2/reports",
        githubOwner: "jacobdjwilson",
        githubRepository: "awesome-annual-security-reports",
      },
      reddit: {
        enabled: false,
        subreddits: ["blueteamsec"],
        cadenceHours: 1,
        queryWindowHours: 12,
        maxItemsPerPoll: 50,
        maxDetailFetches: 25,
        requestTimeoutMs: 15000,
        maxResponseBytes: 2000000,
      },
      cves: {
        enabled: false,
        endpoint: "https://cve.circl.lu/api/vulnerability/recent",
        cadenceHours: 6,
        queryWindowHours: 24,
        retentionDays: 7,
        requestTimeoutMs: 30000,
        maxResponseBytes: 20000000,
      },
      githubTrending: {
        enabled: false,
        endpoint: "https://github.com/trending?since=daily",
        cadenceHours: 6,
        maxItemsPerPoll: 25,
        maxDetailFetches: 25,
        requestTimeoutMs: 20000,
        maxResponseBytes: 10000000,
      },
    });
  });

  it("allows YouTube to be disabled without a key", () => {
    expect(
      parseLocalConfig("[sources.youtube]\nenabled = false", undefined).youtube
        .enabled,
    ).toBe(false);
  });

  it("rejects an enabled YouTube source without a key", () => {
    expect(() => parseLocalConfig(validConfig)).toThrow(
      "YOUTUBE_API_KEY is required",
    );
  });

  it("allows disabled Mediastack without a key", () => {
    expect(
      parseLocalConfig("[sources.mediastack]\nenabled = false\nkeywords = []")
        .mediastack.enabled,
    ).toBe(false);
  });

  it("rejects enabled Mediastack without its environment key", () => {
    expect(() =>
      parseLocalConfig(
        '[sources.mediastack]\nenabled = true\nkeywords = ["China"]',
      ),
    ).toThrow("MEDIASTACK_API_KEY is required");
  });

  it("rejects duplicate keywords and invalid cadence", () => {
    expect(() =>
      parseLocalConfig(
        '[sources.mediastack]\nenabled = false\nkeywords = ["China", "china"]',
      ),
    ).toThrow("must not contain duplicates");
    expect(() =>
      parseLocalConfig(
        "[sources.mediastack]\nenabled = false\ncadence_hours = 0.1",
      ),
    ).toThrow("cadence_hours");
  });

  it("rejects invalid ingestion windows", () => {
    expect(() =>
      parseLocalConfig(
        `[ingestion]\nwindow_hours = 0\n${validConfig}`,
        "configured-secret",
      ),
    ).toThrow("ingestion.window_hours");
  });

  it("rejects invalid video limits", () => {
    expect(() =>
      parseLocalConfig(
        validConfig.replace(
          "max_videos_per_sync = 20",
          "max_videos_per_sync = 101",
        ),
        "configured-secret",
      ),
    ).toThrow("max_videos_per_sync");
  });
});
