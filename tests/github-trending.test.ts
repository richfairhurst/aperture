import { describe, expect, it } from "vitest";
import { GitHubTrendingClient } from "../src/providers/github-trending";

const now = new Date("2026-10-15T12:00:00.000Z");

const trendingHtml = `
  <article class="Box-row">
    <h2><a href="/acme/secure-agent">acme / secure-agent</a></h2>
    <p>Secure agent tooling for defensive automation.</p>
    <span itemprop="programmingLanguage">TypeScript</span>
    <a href="/acme/secure-agent/stargazers">1,234</a>
    <a href="/acme/secure-agent/forks">321</a>
    <span>90 stars today</span>
  </article>
  <article class="Box-row">
    <h2><a href="/acme/no-readme">acme / no-readme</a></h2>
    <p>A project without useful documentation.</p>
  </article>`;

describe("GitHub Trending client", () => {
  it("parses repositories and uses README content as the document", async () => {
    const calls: string[] = [];
    const client = new GitHubTrendingClient({
      endpoint: "https://github.com/trending?since=daily",
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("trending")) return new Response(trendingHtml);
        if (url.includes("secure-agent")) {
          return new Response(
            "# Secure Agent\n\nThis README contains enough substantive technical documentation to evaluate the project, its security model, and its operational use cases.",
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const result = await client.poll(now);

    expect(result.failures).toEqual([
      "acme/no-readme: repository has no readable README",
    ]);
    expect(result.repositoriesFound).toBe(2);
    expect(result.readmesFetched).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      id: "acme/secure-agent",
      title: "acme / secure-agent",
      category: "github_project",
      language: "TypeScript",
      trendingRank: 1,
      stars: 90,
      content: expect.stringContaining("substantive technical documentation"),
      readmeUrl:
        "https://raw.githubusercontent.com/acme/secure-agent/HEAD/README.md",
    });
    expect(calls).toEqual([
      "https://github.com/trending?since=daily",
      "https://raw.githubusercontent.com/acme/secure-agent/HEAD/README.md",
      "https://raw.githubusercontent.com/acme/no-readme/HEAD/README.md",
      "https://raw.githubusercontent.com/acme/no-readme/HEAD/README.rst",
      "https://raw.githubusercontent.com/acme/no-readme/HEAD/README",
    ]);
  });

  it("suppresses polling until the configured cadence elapses", async () => {
    const client = new GitHubTrendingClient({
      endpoint: "https://github.com/trending?since=daily",
      fetchImpl: async () => new Response(trendingHtml),
    });

    await client.poll(now);

    expect(client.canPoll(new Date("2026-10-15T17:59:59.000Z"), 6)).toBe(false);
    expect(client.canPoll(new Date("2026-10-15T18:00:00.000Z"), 6)).toBe(true);
  });
});
