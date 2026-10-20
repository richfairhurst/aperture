import { describe, expect, it } from "vitest";
import {
  ReadwiseApiError,
  ReadwiseClient,
  ReadwiseResponseError,
} from "../src/providers/readwise";

const firstDocument = {
  id: "doc-1",
  url: "https://example.com/one",
  source_url: "https://example.com/one",
  title: "First document",
  author: "Author One",
  html_content: "<p>First content</p>",
  category: "article",
  created_at: "2026-10-06T08:00:00Z",
  updated_at: "2026-10-06T08:05:00Z",
  published_date: "2026-10-06T07:00:00Z",
  saved_at: "2026-10-06T08:00:00Z",
  site_name: "Example",
  readwise_url: "https://readwise.io/read/doc-1",
  image_url: null,
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Readwise client", () => {
  it("follows pagination and sends the token server-side", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new ReadwiseClient("test-token", {
      fetchImpl: async (input, init) => {
        requests.push({
          url: input.toString(),
          authorization: new Headers(init?.headers).get("authorization"),
        });

        if (requests.length === 1) {
          return jsonResponse({
            results: [firstDocument],
            nextPageCursor: "cursor-2",
          });
        }

        return jsonResponse({
          results: [
            { ...firstDocument, id: "doc-2", title: "Second document" },
          ],
          nextPageCursor: null,
        });
      },
    });

    const documents = await client.listDocuments({
      updatedAfter: "2026-10-06T00:00:00Z",
    });

    expect(documents.map((document) => document.id)).toEqual([
      "doc-1",
      "doc-2",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toBe("Token test-token");

    const firstUrl = new URL(requests[0]?.url ?? "");
    expect(firstUrl.searchParams.get("updatedAfter")).toBe(
      "2026-10-06T00:00:00Z",
    );
    expect(firstUrl.searchParams.get("withHtmlContent")).toBe("true");
    expect(firstUrl.searchParams.get("pageCursor")).toBeNull();

    const secondUrl = new URL(requests[1]?.url ?? "");
    expect(secondUrl.searchParams.get("pageCursor")).toBe("cursor-2");
  });

  it("parses optional fields that are absent", async () => {
    const client = new ReadwiseClient("test-token", {
      fetchImpl: async () =>
        jsonResponse({
          results: [
            {
              ...firstDocument,
              author: null,
              html_content: null,
              source_url: undefined,
            },
          ],
        }),
    });

    const [document] = await client.listDocuments();

    expect(document?.author).toBeNull();
    expect(document?.htmlContent).toBeNull();
    expect(document?.sourceUrl).toBeNull();
  });

  it("classifies rate limits without exposing the token", async () => {
    const client = new ReadwiseClient("secret-token", {
      fetchImpl: async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    });

    try {
      await client.fetchPage();
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ReadwiseApiError);
      expect((error as ReadwiseApiError).status).toBe(429);
      expect((error as ReadwiseApiError).retryAfter).toBe("30");
      expect((error as Error).message).not.toContain("secret-token");
    }
  });

  it("rejects malformed provider responses", async () => {
    const client = new ReadwiseClient("test-token", {
      fetchImpl: async () =>
        jsonResponse({ results: [{ id: "missing-fields" }] }),
    });

    await expect(client.fetchPage()).rejects.toBeInstanceOf(
      ReadwiseResponseError,
    );
  });

  it("requires a token", () => {
    expect(() => new ReadwiseClient("  ")).toThrow("READWISE_API_TOKEN");
  });
});
