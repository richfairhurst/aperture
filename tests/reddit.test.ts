import { describe, expect, it } from "vitest";
import { RedditClient } from "../src/providers/reddit";

const now = new Date("2026-10-14T12:00:00.000Z");

describe("Reddit RSS client", () => {
  it("parses Atom entries, follows external links, and keeps substantive self-posts", async () => {
    const calls: string[] = [];
    const client = new RedditClient({
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("blueteamsec.rss")) {
          return new Response(
            `<?xml version="1.0"?><feed>
              <entry>
                <id>t3_external</id><title>External article</title>
                <published>2026-10-14T11:00:00Z</published>
                <author><name>/u/tester</name></author>
                <link rel="alternate" href="https://www.reddit.com/r/blueteamsec/comments/external/" />
                <content type="html">&lt;a href="https://example.com/article"&gt;[link]&lt;/a&gt; &lt;a href="https://www.reddit.com/r/blueteamsec/comments/external/"&gt;[comments]&lt;/a&gt;</content>
              </entry>
              <entry>
                <id>t3_self</id><title>Useful self post</title>
                <published>2026-10-14T10:00:00Z</published>
                <link rel="alternate" href="https://www.reddit.com/r/blueteamsec/comments/self/" />
                <content type="html">This is a substantive self post with enough operational detail to be useful to defenders, analysts, incident responders, detection engineers, and security leaders making practical decisions.</content>
              </entry>
            </feed>`,
            { headers: { "content-type": "application/atom+xml" } },
          );
        }
        return new Response(
          "<html><body><article>Article content with enough operational detail for normalization, evaluation, detection engineering, incident response, and practical defender decision making across security operations, threat hunting, resilience, and governance.</article></body></html>",
          { headers: { "content-type": "text/html" } },
        );
      },
      maxDetailFetches: 5,
    });

    const result = await client.poll(["blueteamsec"], 12, now);

    expect(result.failures).toEqual([]);
    expect(result.entriesFound).toBe(2);
    expect(result.articleFetches).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual(["external", "self"]);
    expect(result.items[0]?.url).toBe("https://example.com/article");
    expect(result.items[1]?.url).toContain("reddit.com");
    expect(calls).toEqual([
      "https://www.reddit.com/r/blueteamsec.rss",
      "https://example.com/article",
    ]);
  });

  it("rejects unsafe external links and records no article fetch", async () => {
    const client = new RedditClient({
      fetchImpl: async () =>
        new Response(
          `<feed><entry><id>t3_bad</id><title>Unsafe</title><published>2026-10-14T11:00:00Z</published><link rel="alternate" href="https://www.reddit.com/r/blueteamsec/comments/bad/" /><content>&lt;a href="http://127.0.0.1/admin"&gt;[link]&lt;/a&gt;</content></entry></feed>`,
        ),
    });

    const result = await client.poll(["blueteamsec"], 12, now);

    expect(result.articleFetches).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});
