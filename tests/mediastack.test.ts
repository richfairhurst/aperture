import { describe, expect, it } from "vitest";
import {
  MediastackApiError,
  MediastackClient,
  MediastackResponseError,
} from "../src/providers/mediastack";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const article = {
  title: "A geopolitical development",
  source: "Example News",
  url: "https://example.com/story",
  description: "A useful description.",
  published_at: "2026-10-08T10:00:00+00:00",
  author: "Reporter",
  image: "https://example.com/image.jpg",
  language: "en",
  country: "gb",
  category: "general",
};

describe("Mediastack client", () => {
  it("parses an article and sends the configured keyword window", async () => {
    let requestUrl: URL | undefined;
    const client = new MediastackClient("secret-key", {
      endpoint: "https://mediastack.test/v1/news",
      now: () => new Date("2026-10-08T12:00:00Z"),
      fetchImpl: async (input) => {
        requestUrl = new URL(input.toString());
        return jsonResponse({ data: [article] });
      },
    });

    const [result] = await client.queryKeyword("China", 12);

    expect(result).toMatchObject({
      id: "https://example.com/story|2026-10-08T10:00:00+00:00",
      keyword: "China",
      title: "A geopolitical development",
      source: "Example News",
      publishedAt: "2026-10-08T10:00:00+00:00",
    });
    expect(requestUrl?.searchParams.get("access_key")).toBe("secret-key");
    expect(requestUrl?.searchParams.get("keywords")).toBe("China");
    expect(requestUrl?.searchParams.get("languages")).toBe("en");
    expect(requestUrl?.searchParams.get("date")).toBe("2026-10-08,2026-10-08");
  });

  it("queries keywords sequentially and applies the delay between them", async () => {
    const events: string[] = [];
    const client = new MediastackClient("secret-key", {
      fetchImpl: async (input) => {
        events.push(
          new URL(input.toString()).searchParams.get("keywords") ?? "",
        );
        return jsonResponse({ data: [] });
      },
      sleep: async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
      },
    });

    const result = await client.queryKeywords(
      ["China", "Iran", "Russia"],
      12,
      2,
    );

    expect(result).toMatchObject({
      queriesExecuted: 3,
      articles: [],
      failures: [],
    });
    expect(events).toEqual([
      "China",
      "sleep:2000",
      "Iran",
      "sleep:2000",
      "Russia",
    ]);
  });

  it("isolates rate-limit failures while continuing remaining keywords", async () => {
    const client = new MediastackClient("secret-key", {
      fetchImpl: async (input) => {
        const keyword = new URL(input.toString()).searchParams.get("keywords");
        if (keyword === "Iran") {
          return jsonResponse(
            {
              error: {
                code: "rate_limit_reached",
                message: "Too many requests",
              },
            },
            { status: 429 },
          );
        }
        return jsonResponse({ data: [article] });
      },
      sleep: async () => undefined,
    });

    const result = await client.queryKeywords(
      ["China", "Iran", "Russia"],
      12,
      0,
    );

    expect(result.queriesExecuted).toBe(3);
    expect(result.articles).toHaveLength(2);
    expect(result.failures).toEqual([
      {
        keyword: "Iran",
        message: "Mediastack request failed with status 429: Too many requests",
        status: 429,
      },
    ]);
  });

  it("classifies malformed responses and requires a key", async () => {
    expect(() => new MediastackClient("  ")).toThrow("MEDIASTACK_API_KEY");
    const client = new MediastackClient("secret-key", {
      fetchImpl: async () => jsonResponse({ data: [{ url: "missing-title" }] }),
    });
    await expect(client.queryKeyword("China", 12)).rejects.toBeInstanceOf(
      MediastackResponseError,
    );
    const rateLimited = new MediastackClient("secret-key", {
      fetchImpl: async () =>
        jsonResponse({ error: { message: "No access" } }, { status: 401 }),
    });
    await expect(rateLimited.queryKeyword("China", 12)).rejects.toBeInstanceOf(
      MediastackApiError,
    );
  });
});
