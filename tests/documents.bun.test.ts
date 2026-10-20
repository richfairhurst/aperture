import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import {
  createDocumentVersion,
  createNormalizedDocumentVersion,
  persistDocumentRevision,
  upsertDocument,
  type DocumentInput,
} from "../src/repositories/documents";

const documentInput: DocumentInput = {
  sourceName: "rss",
  sourceItemId: "doc-1",
  readwiseId: "doc-1",
  sourceUrl: "https://example.com/article",
  readwiseUrl: "https://readwise.io/read/doc-1",
  title: "Example article",
  author: "Example author",
  siteName: "Example site",
  category: "article",
  publishedDate: "2026-10-06T09:00:00Z",
  savedAt: "2026-10-06T09:30:00Z",
  createdAt: "2026-10-06T10:00:00Z",
  updatedAt: "2026-10-06T10:00:00Z",
  createdTimestamp: "2026-10-06T10:00:00Z",
  updatedTimestamp: "2026-10-06T10:00:00Z",
};

describe("document repositories", () => {
  it("upserts the stable document identity without creating duplicates", async () => {
    const database = await openDatabase(":memory:");

    const first = upsertDocument(database, documentInput);
    const second = upsertDocument(database, {
      ...documentInput,
      title: "Updated example article",
      updatedTimestamp: "2026-10-06T11:00:00Z",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(second.document.title).toBe("Updated example article");

    const count = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM documents")
      .get();
    expect(count?.count).toBe(1);
    database.close();
  });

  it("rejects non-HTTP(S) source URLs before persistence", async () => {
    const database = await openDatabase(":memory:");

    expect(() =>
      upsertDocument(database, {
        ...documentInput,
        sourceUrl: "javascript:alert(1)",
      }),
    ).toThrow("Only HTTP(S) URLs are allowed");
    expect(
      database.query("SELECT COUNT(*) AS count FROM documents").get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("creates one revision per document content hash", async () => {
    const database = await openDatabase(":memory:");
    const document = upsertDocument(database, documentInput).document;

    const first = createDocumentVersion(database, {
      documentId: document.id,
      contentHash: "hash-1",
      normalizedText: "First article text",
      wordCount: 3,
      contentTruncated: false,
      sourceUpdatedTimestamp: documentInput.updatedTimestamp,
      ingestedAt: "2026-10-06T10:01:00Z",
    });
    const duplicate = createDocumentVersion(database, {
      documentId: document.id,
      contentHash: "hash-1",
      normalizedText: "First article text changed locally",
      wordCount: 5,
      contentTruncated: true,
      sourceUpdatedTimestamp: documentInput.updatedTimestamp,
      ingestedAt: "2026-10-06T10:02:00Z",
    });
    const changed = createDocumentVersion(database, {
      documentId: document.id,
      contentHash: "hash-2",
      normalizedText: "Second article text",
      wordCount: 3,
      contentTruncated: false,
      sourceUpdatedTimestamp: "2026-10-06T11:00:00Z",
      ingestedAt: "2026-10-06T11:01:00Z",
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.version.id).toBe(first.version.id);
    expect(duplicate.version.normalizedText).toBe("First article text");
    expect(changed.created).toBe(true);

    const count = database
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM document_versions WHERE document_id = ?",
      )
      .get(document.id);
    expect(count?.count).toBe(2);
    database.close();
  });

  it("persists a document and revision atomically", async () => {
    const database = await openDatabase(":memory:");

    const result = persistDocumentRevision(database, documentInput, {
      contentHash: "hash-1",
      normalizedText: "Normalized article text",
      wordCount: 3,
      contentTruncated: false,
      sourceUpdatedTimestamp: documentInput.updatedTimestamp,
      ingestedAt: "2026-10-06T10:01:00Z",
    });

    expect(result.documentCreated).toBe(true);
    expect(result.versionCreated).toBe(true);
    expect(result.version.documentId).toBe(result.document.id);
    database.close();
  });

  it("does not leave a document when revision persistence fails", async () => {
    const database = await openDatabase(":memory:");

    expect(() =>
      persistDocumentRevision(database, documentInput, {
        contentHash: "hash-1",
        normalizedText: "Normalized article text",
        wordCount: -1,
        contentTruncated: false,
        sourceUpdatedTimestamp: documentInput.updatedTimestamp,
        ingestedAt: "2026-10-06T10:01:00Z",
      }),
    ).toThrow();

    const count = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM documents")
      .get();
    expect(count?.count).toBe(0);
    database.close();
  });

  it("persists the prepared hash and truncation metadata", async () => {
    const database = await openDatabase(":memory:");
    const document = upsertDocument(database, documentInput).document;

    const result = createNormalizedDocumentVersion(database, {
      documentId: document.id,
      normalizedText: "First paragraph.\n\nSecond paragraph.",
      maxCharacters: 20,
      sourceUpdatedTimestamp: documentInput.updatedTimestamp,
      ingestedAt: "2026-10-06T10:01:00Z",
    });

    expect(result.content.contentTruncated).toBe(true);
    expect(result.version.contentTruncated).toBe(true);
    expect(result.version.contentHash).toBe(result.content.contentHash);
    expect(result.version.normalizedText).toBe("First paragraph.");
    database.close();
  });
});
