import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";

type TableRow = {
  name: string;
};

type ForeignKeysRow = {
  foreign_keys: number;
};

type MigrationRow = {
  count: number;
};

describe("local SQLite database", () => {
  it("creates and migrates an on-disk database path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "surface-mvp-"));
    const databasePath = join(directory, "aperture.sqlite");
    const database = await openDatabase(databasePath);

    const migrationCount = database
      .query<MigrationRow, []>(
        "SELECT COUNT(*) AS count FROM schema_migrations",
      )
      .get();

    expect(migrationCount?.count).toBe(16);
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("applies the initial schema with foreign keys enabled", async () => {
    const database = await openDatabase(":memory:");

    const tables = database
      .query<TableRow, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .filter((table) => !table.name.startsWith("sqlite_"))
      .map((table) => table.name);

    expect(tables).toEqual([
      "auth_sessions",
      "document_versions",
      "documents",
      "evaluations",
      "feed_items",
      "magic_link_tokens",
      "mediastack_document_keywords",
      "mediastack_keyword_usage",
      "mediastack_runs",
      "mediastack_usage",
      "processing_errors",
      "report_discovery_runs",
      "report_evaluations",
      "report_summaries",
      "report_versions",
      "reports",
      "schema_migrations",
      "summaries",
      "sync_runs",
      "sync_skips",
      "triage_decisions",
      "users",
      "vulnerabilities",
      "vulnerability_runs",
    ]);

    const foreignKeys = database
      .query<ForeignKeysRow, []>("PRAGMA foreign_keys")
      .get();

    expect(foreignKeys?.foreign_keys).toBe(1);
    database.close();
  });

  it("does not apply a migration more than once", async () => {
    const database = await openDatabase(":memory:");

    const migrationCount = database
      .query<MigrationRow, []>(
        "SELECT COUNT(*) AS count FROM schema_migrations",
      )
      .get();

    expect(migrationCount?.count).toBe(16);
    database.close();
  });

  it("supports a basic document and revision insert/read", async () => {
    const database = await openDatabase(":memory:");

    const documentResult = database
      .query(
        "INSERT INTO documents (source_name, source_item_id, readwise_id, source_url, title, category, created_at, updated_at, created_timestamp, updated_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "rss",
        "doc-1",
        "doc-1",
        "https://example.com/article",
        "Example article",
        "article",
        "2026-10-06T10:00:00Z",
        "2026-10-06T10:00:00Z",
        "2026-10-06T10:00:00Z",
        "2026-10-06T10:00:00Z",
      );

    database
      .query(
        "INSERT INTO document_versions (document_id, content_hash, normalized_text, word_count, ingested_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        documentResult.lastInsertRowid,
        "hash-1",
        "Normalized article text",
        3,
        "2026-10-06T10:01:00Z",
      );

    const revision = database
      .query<{ normalized_text: string }, [number]>(
        "SELECT normalized_text FROM document_versions WHERE document_id = ?",
      )
      .get(Number(documentResult.lastInsertRowid));

    expect(revision?.normalized_text).toBe("Normalized article text");
    database.close();
  });

  it("rejects orphaned document revisions", async () => {
    const database = await openDatabase(":memory:");

    expect(() => {
      database
        .query(
          "INSERT INTO document_versions (document_id, content_hash, normalized_text, word_count, ingested_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(999, "hash-1", "text", 1, "2026-10-06T10:01:00Z");
    }).toThrow();

    database.close();
  });
});
