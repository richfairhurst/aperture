import type { Database } from "bun:sqlite";
import {
  prepareNormalizedContent,
  type PreparedContent,
} from "../pipeline/content";
import { assertHttpUrl, safeHttpUrl } from "../utils/safe-url";

export type DocumentInput = {
  sourceName: string;
  sourceItemId: string;
  readwiseId: string | null;
  sourceUrl: string | null;
  readwiseUrl: string | null;
  title: string;
  author: string | null;
  siteName: string | null;
  category: string;
  publishedDate: string | null;
  savedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdTimestamp: string;
  updatedTimestamp: string;
};

export type DocumentVersionInput = {
  documentId: number;
  contentHash: string;
  normalizedText: string;
  wordCount: number;
  contentTruncated: boolean;
  sourceUpdatedTimestamp: string | null;
  ingestedAt: string;
};

export type DocumentRecord = DocumentInput & {
  id: number;
};

export type DocumentVersionRecord = DocumentVersionInput & {
  id: number;
};

export type PersistedDocumentRevision = {
  document: DocumentRecord;
  version: DocumentVersionRecord;
  documentCreated: boolean;
  versionCreated: boolean;
};

export type NormalizedRevisionInput = {
  documentId: number;
  normalizedText: string;
  sourceUpdatedTimestamp: string | null;
  ingestedAt: string;
  maxCharacters?: number;
};

type DocumentRow = {
  id: number;
  source_name: string;
  source_item_id: string;
  readwise_id: string | null;
  source_url: string;
  readwise_url: string | null;
  title: string;
  author: string | null;
  site_name: string | null;
  category: string;
  published_date: string | null;
  saved_at: string | null;
  created_at: string;
  updated_at: string;
  created_timestamp: string;
  updated_timestamp: string;
};

type DocumentVersionRow = {
  id: number;
  document_id: number;
  content_hash: string;
  normalized_text: string;
  word_count: number;
  content_truncated: number;
  source_updated_timestamp: string | null;
  ingested_at: string;
};

export function upsertDocument(
  database: Database,
  input: DocumentInput,
): { document: DocumentRecord; created: boolean } {
  const sourceUrl = assertHttpUrl(input.sourceUrl ?? "");
  const existing = findDocument(database, input.sourceName, input.sourceItemId);

  database
    .query(
      `INSERT INTO documents (
        source_name, source_item_id, readwise_id, source_url, readwise_url,
        title, author, site_name, category, published_date, saved_at,
        created_at, updated_at, created_timestamp, updated_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_name, source_item_id) DO UPDATE SET
        readwise_id = excluded.readwise_id,
        source_url = excluded.source_url,
        readwise_url = excluded.readwise_url,
        title = excluded.title,
        author = excluded.author,
        site_name = excluded.site_name,
        category = excluded.category,
        published_date = excluded.published_date,
        saved_at = excluded.saved_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        created_timestamp = excluded.created_timestamp,
        updated_timestamp = excluded.updated_timestamp`,
    )
    .run(
      input.sourceName,
      input.sourceItemId,
      input.readwiseId,
      sourceUrl,
      input.readwiseUrl,
      input.title,
      input.author,
      input.siteName,
      input.category,
      input.publishedDate,
      input.savedAt,
      input.createdAt,
      input.updatedAt,
      input.createdTimestamp,
      input.updatedTimestamp,
    );

  const document = findDocument(database, input.sourceName, input.sourceItemId);
  if (!document) {
    throw new Error("Document was not found after upsert");
  }

  return { document, created: existing === null };
}

export function findDocument(
  database: Database,
  sourceName: string,
  sourceItemId: string,
): DocumentRecord | null {
  const row = database
    .query<DocumentRow, [string, string]>(
      "SELECT * FROM documents WHERE source_name = ? AND source_item_id = ?",
    )
    .get(sourceName, sourceItemId);

  return row ? toDocumentRecord(row) : null;
}

export function listDocuments(
  database: Database,
  limit = 100,
): DocumentRecord[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Document limit must be an integer from 1 to 200");
  }

  const rows = database
    .query<DocumentRow, [number]>(
      `SELECT * FROM documents
       ORDER BY created_timestamp DESC, id DESC
       LIMIT ?`,
    )
    .all(limit);

  return rows.map(toDocumentRecord);
}

export function createDocumentVersion(
  database: Database,
  input: DocumentVersionInput,
): { version: DocumentVersionRecord; created: boolean } {
  if (!Number.isInteger(input.wordCount) || input.wordCount < 0) {
    throw new Error(
      "Document version word count must be a non-negative integer",
    );
  }

  const existing = findDocumentVersion(
    database,
    input.documentId,
    input.contentHash,
  );

  database
    .query(
      `INSERT INTO document_versions (
        document_id, content_hash, normalized_text, word_count,
        content_truncated, source_updated_timestamp, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (document_id, content_hash) DO NOTHING`,
    )
    .run(
      input.documentId,
      input.contentHash,
      input.normalizedText,
      input.wordCount,
      input.contentTruncated ? 1 : 0,
      input.sourceUpdatedTimestamp,
      input.ingestedAt,
    );

  const version = findDocumentVersion(
    database,
    input.documentId,
    input.contentHash,
  );
  if (!version) {
    throw new Error("Document version was not found after insert");
  }

  return { version, created: existing === null };
}

export function createNormalizedDocumentVersion(
  database: Database,
  input: NormalizedRevisionInput,
): {
  version: DocumentVersionRecord;
  created: boolean;
  content: PreparedContent;
} {
  const content = prepareNormalizedContent(
    input.normalizedText,
    input.maxCharacters,
  );
  const result = createDocumentVersion(database, {
    documentId: input.documentId,
    contentHash: content.contentHash,
    normalizedText: content.normalizedText,
    wordCount: content.wordCount,
    contentTruncated: content.contentTruncated,
    sourceUpdatedTimestamp: input.sourceUpdatedTimestamp,
    ingestedAt: input.ingestedAt,
  });

  return { ...result, content };
}

export function findDocumentVersion(
  database: Database,
  documentId: number,
  contentHash: string,
): DocumentVersionRecord | null {
  const row = database
    .query<DocumentVersionRow, [number, string]>(
      "SELECT * FROM document_versions WHERE document_id = ? AND content_hash = ?",
    )
    .get(documentId, contentHash);

  return row ? toDocumentVersionRecord(row) : null;
}

export function persistDocumentRevision(
  database: Database,
  documentInput: DocumentInput,
  versionInput: Omit<DocumentVersionInput, "documentId">,
): PersistedDocumentRevision {
  return database.transaction(() => {
    const documentResult = upsertDocument(database, documentInput);
    const versionResult = createDocumentVersion(database, {
      ...versionInput,
      documentId: documentResult.document.id,
    });

    return {
      document: documentResult.document,
      version: versionResult.version,
      documentCreated: documentResult.created,
      versionCreated: versionResult.created,
    };
  })();
}

function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    sourceName: row.source_name,
    sourceItemId: row.source_item_id,
    readwiseId: row.readwise_id,
    sourceUrl: safeHttpUrl(row.source_url),
    readwiseUrl: row.readwise_url,
    title: row.title,
    author: row.author,
    siteName: row.site_name,
    category: row.category,
    publishedDate: row.published_date,
    savedAt: row.saved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdTimestamp: row.created_timestamp,
    updatedTimestamp: row.updated_timestamp,
  };
}

function toDocumentVersionRecord(
  row: DocumentVersionRow,
): DocumentVersionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    contentHash: row.content_hash,
    normalizedText: row.normalized_text,
    wordCount: row.word_count,
    contentTruncated: row.content_truncated === 1,
    sourceUpdatedTimestamp: row.source_updated_timestamp,
    ingestedAt: row.ingested_at,
  };
}
