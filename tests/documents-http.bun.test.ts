import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { createRequestHandler } from "../src/http/app";
import { persistSyncCandidates } from "../src/pipeline/sync";
import type { ReadwiseDocument } from "../src/providers/readwise";

const document: ReadwiseDocument = {
  id: "doc-1",
  url: "https://example.com/article",
  sourceUrl: "https://example.com/article",
  title: "Example article",
  author: "Example author",
  htmlContent: "<p>Article content</p>",
  category: "article",
  createdAt: "2026-10-06T11:00:00Z",
  updatedAt: "2026-10-06T11:00:00Z",
  publishedDate: null,
  savedAt: null,
  siteName: "Example site",
  readwiseUrl: "https://readwise.io/read/doc-1",
  imageUrl: null,
};

describe("document ingestion HTTP route", () => {
  it("returns safe imported metadata and latest sync details", async () => {
    const database = await openDatabase(":memory:");
    persistSyncCandidates(database, [document], {
      now: new Date("2026-10-06T12:00:00Z"),
    });
    const handler = createRequestHandler({ database });

    const response = await handler(
      new Request("http://localhost/api/documents?limit=10"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]).toMatchObject({
      title: "Example article",
      sourceUrl: "https://example.com/article",
      category: "article",
    });
    expect(body.documents[0]).not.toHaveProperty("htmlContent");
    expect(body.latestRun).toMatchObject({
      itemsFound: 1,
      itemsPersisted: 1,
      itemsSkipped: 0,
    });
    expect(JSON.stringify(body)).not.toContain("Article content");
    database.close();
  });

  it("rejects an invalid document limit", async () => {
    const database = await openDatabase(":memory:");
    const handler = createRequestHandler({ database });

    const response = await handler(
      new Request("http://localhost/api/documents?limit=999"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_limit",
      message: "limit must be an integer from 1 to 200.",
    });
    database.close();
  });
});
