import { describe, expect, it } from "vitest";
import {
  GitHubAnnualReportsClient,
  OrklReportClient,
  RostiReportClient,
  discoverReports,
} from "../src/reports/discovery";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("report discovery adapters", () => {
  it("parses ORKL metadata and sends the since watermark", async () => {
    const requestedUrls: string[] = [];
    const client = new OrklReportClient({
      endpoint: "https://orkl.test/reports",
      fetchImpl: async (input) => {
        requestedUrls.push(String(input));
        return response({
          results: [
            {
              id: "orkl-1",
              title: "Campaign report",
              url: "https://orkl.test/report/1",
              published_at: "2026-10-14",
              activity_end_at: "2026-10-10T00:00:00Z",
              report_type: "threat_intelligence",
            },
          ],
        });
      },
    });
    const candidates = await client.discover({
      since: new Date("2026-10-13T00:00:00Z"),
      observedAt: new Date("2026-10-14T12:00:00Z"),
    });
    expect(requestedUrls[0]).toContain("since=2026-10-13T00%3A00%3A00.000Z");
    expect(candidates[0]?.provenance).toMatchObject({
      source: "orkl",
      providerReportId: "orkl-1",
      sourcePublishedAt: "2026-10-14T00:00:00.000Z",
      activityEndAt: "2026-10-10T00:00:00.000Z",
    });
  });

  it("times out an unresponsive ORKL request", async () => {
    const client = new OrklReportClient({
      endpoint: "https://orkl.test/reports",
      requestTimeoutMs: 10,
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });

    await expect(
      client.discover({
        since: new Date("2026-10-13T00:00:00Z"),
        observedAt: new Date("2026-10-14T00:00:00Z"),
      }),
    ).rejects.toThrow("ORKL request timed out after 10ms");
  });

  it("follows provider pagination links", async () => {
    let requests = 0;
    const client = new OrklReportClient({
      endpoint: "https://orkl.test/reports",
      fetchImpl: async (input) => {
        requests += 1;
        if (String(input).includes("page=2")) {
          return response({
            results: [
              { id: "orkl-2", title: "Second", url: "https://orkl.test/2" },
            ],
          });
        }
        return response({
          results: [
            { id: "orkl-1", title: "First", url: "https://orkl.test/1" },
          ],
          next: "https://orkl.test/reports?page=2",
        });
      },
    });
    const candidates = await client.discover({
      since: new Date("2026-10-13T00:00:00Z"),
      observedAt: new Date("2026-10-14T00:00:00Z"),
    });
    expect(requests).toBe(2);
    expect(
      candidates.map((candidate) => candidate.provenance.providerReportId),
    ).toEqual(["orkl-1", "orkl-2"]);
  });

  it("rejects ORKL pagination links on another host", async () => {
    let requests = 0;
    const client = new OrklReportClient({
      endpoint: "https://orkl.test/reports",
      fetchImpl: async () => {
        requests += 1;
        return response({
          results: [],
          next: "https://attacker.test/metadata",
        });
      },
    });

    await expect(
      client.discover({
        since: new Date("2026-10-13T00:00:00Z"),
        observedAt: new Date("2026-10-14T00:00:00Z"),
      }),
    ).rejects.toThrow("ORKL pagination URL is not allowed");
    expect(requests).toBe(1);
  });

  it("rejects an oversized ORKL response before parsing it", async () => {
    const client = new OrklReportClient({
      endpoint: "https://orkl.test/reports",
      fetchImpl: async () => new Response("x".repeat(5_000_001)),
    });

    await expect(
      client.discover({
        since: new Date("2026-10-13T00:00:00Z"),
        observedAt: new Date("2026-10-14T00:00:00Z"),
      }),
    ).rejects.toThrow("response exceeded configured size limit");
  });

  it("authenticates ROSTI and isolates a failed source", async () => {
    let apiKey = "";
    const rosti = new RostiReportClient("secret", {
      endpoint: "https://rosti.test/reports",
      fetchImpl: async (_input, init) => {
        apiKey = new Headers(init?.headers).get("X-Api-Key") ?? "";
        return response({
          data: [
            {
              id: "r-1",
              name: "ROSTI report",
              report_url: "https://rosti.test/r-1",
            },
          ],
        });
      },
    });
    const failed = {
      discover: async () => {
        throw new Error("rate limited");
      },
    };
    const result = await discoverReports(
      { rosti, orkl: failed },
      {
        since: new Date("2026-10-13T00:00:00Z"),
        observedAt: new Date("2026-10-14T00:00:00Z"),
      },
    );
    expect(apiKey).toBe("secret");
    expect(result.candidates).toHaveLength(1);
    expect(result.failures).toEqual(["orkl: rate limited"]);
  });

  it("does not send the ROSTI API key to an untrusted report URL", async () => {
    const requests: Array<{ url: string; apiKey: string; redirect?: string }> =
      [];
    const rosti = new RostiReportClient("secret", {
      endpoint: "https://rosti.test/reports",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          apiKey: new Headers(init?.headers).get("X-Api-Key") ?? "",
          redirect: init?.redirect,
        });
        return response({
          data: [
            {
              id: "r-unsafe",
              name: "Untrusted report",
              report_url: "https://attacker.test/report",
            },
          ],
        });
      },
    });

    const candidates = await rosti.discover({
      since: new Date("2026-10-13T00:00:00Z"),
      observedAt: new Date("2026-10-14T00:00:00Z"),
    });

    expect(candidates).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://rosti.test/reports?timestamp=2026-10-13T00%3A00%3A00.000Z",
      apiKey: "secret",
      redirect: "manual",
    });
  });

  it("infers useful report types when providers omit classification", async () => {
    const client = new OrklReportClient({
      endpoint: "https://orkl.test/reports",
      fetchImpl: async () =>
        response({
          data: [
            {
              id: "m-trends",
              title:
                "M-Trends 2026: Data, Insights, and Strategies From the Frontlines",
              files: { pdf: "https://orkl.test/m-trends.pdf" },
              plain_text: "Report content",
            },
            {
              id: "ransomware",
              title: "Ransomware Tactics and Techniques",
              files: { pdf: "https://orkl.test/ransomware.pdf" },
              plain_text: "Report content",
            },
          ],
        }),
    });
    const candidates = await client.discover({
      since: new Date("2026-10-13T00:00:00Z"),
      observedAt: new Date("2026-10-14T00:00:00Z"),
    });
    expect(
      candidates.map((candidate) => candidate.provenance.reportType),
    ).toEqual(["research", "threat_intelligence"]);
  });

  it("only promotes newly added PDFs under annual year folders on GitHub", async () => {
    const client = new GitHubAnnualReportsClient({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/commits?")) return response([{ sha: "abc123" }]);
        if (url.includes("raw.githubusercontent.com"))
          return new Response("# Example report");
        return response({
          files: [
            { filename: "README.md", status: "added" },
            {
              filename: "Annual Security Reports/2026/Example.pdf",
              status: "added",
            },
            {
              filename: "Annual Security Reports/2026/Existing.pdf",
              status: "modified",
            },
            {
              filename: "Markdown Conversions/2026/Example.md",
              status: "added",
            },
          ],
        });
      },
    });
    const candidates = await client.discover({
      since: new Date("2026-10-13T00:00:00Z"),
      observedAt: new Date("2026-10-14T00:00:00Z"),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("Example");
    expect(candidates[0]?.provenance.reportYear).toBe(2026);
    expect(candidates[0]?.selectedContent).toMatchObject({
      format: "markdown",
      text: "# Example report",
    });
  });
});
