import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import {
  createSyncRun,
  filterReadwiseDocuments,
  getSyncRun,
  processReadwiseSync,
  persistSyncCandidates,
  SyncAlreadyRunningError,
} from "../src/pipeline/sync";
import {
  ReadwiseClient,
  type ReadwiseDocument,
} from "../src/providers/readwise";

const now = new Date("2026-10-06T12:00:00Z");

function document(
  id: string,
  category: string,
  createdAt: string,
  sourceUrl = `https://example.com/${id}`,
  url = `https://example.com/${id}`,
): ReadwiseDocument {
  return {
    id,
    url,
    sourceUrl,
    title: `Document ${id}`,
    author: null,
    htmlContent: `<p>Content ${id}</p>`,
    category,
    createdAt,
    updatedAt: createdAt,
    publishedDate: null,
    savedAt: null,
    siteName: "Example",
    readwiseUrl: `https://readwise.io/read/${id}`,
    imageUrl: null,
  };
}

describe("sync candidate filtering and persistence", () => {
  it("includes the exact 12-hour boundary and rejects older or future items", () => {
    const result = filterReadwiseDocuments(
      [
        document("boundary", "article", "2026-10-06T00:00:00Z"),
        document("old", "article", "2026-10-05T23:59:59Z"),
        document("future", "article", "2026-10-06T12:00:01Z"),
      ],
      { now },
    );

    expect(result.eligible.map((item) => item.id)).toEqual(["boundary"]);
    expect(result.skipped.map((item) => item.reasonCode)).toEqual([
      "created_at_outside_window",
      "created_at_in_future",
    ]);
  });

  it("accepts supported categories and records unsupported categories", () => {
    const result = filterReadwiseDocuments(
      [
        document("article", "article", "2026-10-06T11:00:00Z"),
        document("rss", "rss", "2026-10-06T11:00:00Z"),
        document("email", "email", "2026-10-06T11:00:00Z"),
        document("podcast", "podcast", "2026-10-06T11:00:00Z"),
      ],
      { now },
    );

    expect(result.eligible.map((item) => item.id)).toEqual([
      "article",
      "rss",
      "email",
    ]);
    expect(result.skipped[0]?.reasonCode).toBe("unsupported_category");
  });

  it("records invalid timestamps as a safe skip", () => {
    const result = filterReadwiseDocuments(
      [document("invalid", "article", "not-a-date")],
      { now },
    );

    expect(result.eligible).toHaveLength(0);
    expect(result.skipped[0]?.reasonCode).toBe("invalid_created_at");
  });

  it("skips invalid source URLs without blocking valid documents", () => {
    const result = filterReadwiseDocuments(
      [
        document("valid", "article", "2026-10-06T11:00:00Z"),
        document(
          "forwarded-email",
          "email",
          "2026-10-06T11:00:00Z",
          "mailto:reader-forwarded-email/example",
          "mailto:reader-forwarded-email/example",
        ),
      ],
      { now },
    );

    expect(result.eligible.map((item) => item.id)).toEqual(["valid"]);
    expect(result.skipped[0]?.reasonCode).toBe("invalid_source_url");
  });

  it("persists eligible metadata, counters, and skip reasons idempotently", async () => {
    const database = await openDatabase(":memory:");
    const documents = [
      document("article", "article", "2026-10-06T11:00:00Z"),
      document("old", "article", "2026-10-05T23:59:59Z"),
    ];

    const first = persistSyncCandidates(database, documents, { now });
    const second = persistSyncCandidates(database, documents, { now });

    expect(first.itemsFound).toBe(2);
    expect(first.itemsPersisted).toBe(1);
    expect(first.itemsSkipped).toBe(1);
    expect(second.itemsPersisted).toBe(1);

    const documentCount = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM documents")
      .get();
    const revisionCount = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM document_versions",
      )
      .get();
    const skipCount = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sync_skips")
      .get();

    expect(documentCount?.count).toBe(1);
    expect(revisionCount?.count).toBe(0);
    expect(skipCount?.count).toBe(2);
    database.close();
  });

  it("marks a run failed when the provider request fails", async () => {
    const database = await openDatabase(":memory:");
    const client = new ReadwiseClient("test-token", {
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    });
    const runId = createSyncRun(database, "manual", "2026-10-06T12:00:00.000Z");

    const result = await processReadwiseSync(database, client, {
      now,
      runId,
    });
    const run = getSyncRun(database, runId);

    expect(result).toBeNull();
    expect(run?.status).toBe("failed");
    expect(run?.itemsFailed).toBe(1);
    expect(run?.errorMessage).toBe("Readwise request failed with status 401");
    database.close();
  });

  it("allows only one running sync at a time", async () => {
    const database = await openDatabase(":memory:");
    createSyncRun(database, "manual", now.toISOString());

    expect(() => createSyncRun(database, "manual", now.toISOString())).toThrow(
      SyncAlreadyRunningError,
    );
    database.close();
  });

  it("runs the optional evaluation stage after metadata sync", async () => {
    const database = await openDatabase(":memory:");
    const client = new ReadwiseClient("test-token", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                id: "article",
                url: "https://example.com/article",
                source_url: "https://example.com/article",
                title: "Document article",
                author: null,
                html_content: "<p>Content article</p>",
                category: "article",
                created_at: "2026-10-06T11:00:00Z",
                updated_at: "2026-10-06T11:00:00Z",
                published_date: null,
                saved_at: null,
                site_name: "Example",
                readwise_url: "https://readwise.io/read/article",
                image_url: null,
              },
            ],
            nextPageCursor: null,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const runId = createSyncRun(database, "manual", now.toISOString());

    const result = await processReadwiseSync(database, client, {
      now,
      runId,
      evaluate: async (documents, evaluationNow) => {
        expect(documents).toHaveLength(1);
        expect(evaluationNow).toEqual(now);
        return { itemsProcessed: 1, itemsFailed: 0 };
      },
    });

    expect(result?.itemsPersisted).toBe(1);
    expect(getSyncRun(database, runId)).toMatchObject({
      status: "completed",
      itemsProcessed: 1,
      itemsFailed: 0,
    });
    database.close();
  });
});
