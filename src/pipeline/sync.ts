import type { Database } from "bun:sqlite";
import type { ReadwiseDocument } from "../providers/readwise";
import { ReadwiseClient } from "../providers/readwise";
import { upsertDocument, type DocumentInput } from "../repositories/documents";
import { safeHttpUrl } from "../utils/safe-url";
import { purgeExpiredNews } from "./retention";

export const supportedReadwiseCategories = ["article", "rss", "email"] as const;

type SupportedCategory = (typeof supportedReadwiseCategories)[number];

export type SyncFilterOptions = {
  now?: Date;
  ingestionWindowHours?: number;
};

export type SyncEvaluationRunner = (
  documents: ReadwiseDocument[],
  now: Date,
) => Promise<{ itemsProcessed: number; itemsFailed: number }>;

export type SyncYouTubeRunner = (
  now: Date,
) => Promise<{ itemsProcessed: number; itemsFailed: number }>;

export type SyncMediastackRunner = (
  now: Date,
) => Promise<{ itemsProcessed: number; itemsFailed: number }>;

export type SyncRedditRunner = (
  now: Date,
) => Promise<{ itemsProcessed: number; itemsFailed: number }>;

export type SyncGitHubTrendingRunner = (
  now: Date,
) => Promise<{ itemsProcessed: number; itemsFailed: number }>;

export type SyncSkip = {
  document: ReadwiseDocument;
  reasonCode:
    | "unsupported_category"
    | "invalid_created_at"
    | "invalid_source_url"
    | "created_at_outside_window"
    | "created_at_in_future";
  reason: string;
};

export type FilteredSyncCandidates = {
  eligible: ReadwiseDocument[];
  skipped: SyncSkip[];
};

export type PersistSyncOptions = SyncFilterOptions & {
  trigger?: "manual" | "command";
  startedAt?: string;
  runId?: number;
};

export type SyncResult = {
  runId: number;
  status: "completed";
  itemsFound: number;
  itemsPersisted: number;
  itemsSkipped: number;
  skipped: SyncSkip[];
};

export type StartSyncOptions = SyncFilterOptions & {
  evaluate?: SyncEvaluationRunner;
  youtubeSync?: SyncYouTubeRunner;
  mediastackSync?: SyncMediastackRunner;
  redditSync?: SyncRedditRunner;
  githubTrendingSync?: SyncGitHubTrendingRunner;
};

export type SyncRunRecord = {
  id: number;
  trigger: "manual" | "command";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  itemsFound: number;
  itemsPersisted: number;
  itemsSkipped: number;
  itemsProcessed: number;
  itemsFailed: number;
  errorMessage: string | null;
};

export class SyncAlreadyRunningError extends Error {
  constructor() {
    super("A sync is already running");
    this.name = "SyncAlreadyRunningError";
  }
}

export type SyncSkipRecord = {
  id: number;
  sourceName: string;
  sourceItemId: string;
  reasonCode: string;
  reason: string;
  createdAt: string;
};

type SyncRunRow = {
  id: number;
  trigger: "manual" | "command";
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at: string | null;
  items_found: number;
  items_persisted: number;
  items_skipped: number;
  items_processed: number;
  items_failed: number;
  error_message: string | null;
};

export function filterReadwiseDocuments(
  documents: ReadwiseDocument[],
  options: SyncFilterOptions = {},
): FilteredSyncCandidates {
  const now = options.now ?? new Date();
  const ingestionWindowHours =
    options.ingestionWindowHours ?? readIngestionWindowHours();

  if (!Number.isFinite(ingestionWindowHours) || ingestionWindowHours <= 0) {
    throw new Error("INGESTION_WINDOW_HOURS must be a positive number");
  }

  const windowStart = now.getTime() - ingestionWindowHours * 60 * 60 * 1000;
  const eligible: ReadwiseDocument[] = [];
  const skipped: SyncSkip[] = [];

  for (const document of documents) {
    if (!isSupportedCategory(document.category)) {
      skipped.push({
        document,
        reasonCode: "unsupported_category",
        reason: `Category '${document.category}' is not supported by the local MVP`,
      });
      continue;
    }

    const createdAt = Date.parse(document.createdAt);
    if (Number.isNaN(createdAt)) {
      skipped.push({
        document,
        reasonCode: "invalid_created_at",
        reason: "Readwise created_at is not a valid timestamp",
      });
      continue;
    }

    if (createdAt > now.getTime()) {
      skipped.push({
        document,
        reasonCode: "created_at_in_future",
        reason: "Readwise created_at is later than the sync time",
      });
      continue;
    }

    if (createdAt < windowStart) {
      skipped.push({
        document,
        reasonCode: "created_at_outside_window",
        reason: `Readwise created_at is outside the previous ${ingestionWindowHours} hours`,
      });
      continue;
    }

    if (!getSafeSourceUrl(document)) {
      skipped.push({
        document,
        reasonCode: "invalid_source_url",
        reason: "Readwise source URL is not a valid HTTP(S) URL",
      });
      continue;
    }

    eligible.push(document);
  }

  return { eligible, skipped };
}

export function persistSyncCandidates(
  database: Database,
  documents: ReadwiseDocument[],
  options: PersistSyncOptions = {},
): SyncResult {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const filtered = filterReadwiseDocuments(documents, options);
  const runId =
    options.runId ??
    createSyncRun(database, options.trigger ?? "manual", startedAt);

  for (const skipped of filtered.skipped) {
    database
      .query(
        `INSERT INTO sync_skips (
          sync_run_id, source_name, source_item_id, reason_code, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        "rss",
        skipped.document.id,
        skipped.reasonCode,
        skipped.reason,
        startedAt,
      );
  }

  let itemsPersisted = 0;
  for (const document of filtered.eligible) {
    upsertDocument(database, toDocumentInput(document));
    itemsPersisted += 1;
  }

  database
    .query(
      `UPDATE sync_runs
       SET status = 'completed',
           finished_at = ?,
           items_found = ?,
           items_persisted = ?,
           items_skipped = ?
       WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      documents.length,
      itemsPersisted,
      filtered.skipped.length,
      runId,
    );

  return {
    runId,
    status: "completed",
    itemsFound: documents.length,
    itemsPersisted,
    itemsSkipped: filtered.skipped.length,
    skipped: filtered.skipped,
  };
}

export function startReadwiseSync(
  database: Database,
  client: ReadwiseClient,
  options: StartSyncOptions = {},
): number | null {
  const now = options.now ?? new Date();
  const retention = purgeExpiredNews(database, now);
  if (retention.documentsDeleted > 0) {
    console.info(
      `News retention removed ${retention.documentsDeleted} expired documents`,
    );
  }
  let runId: number;
  try {
    runId = createSyncRun(database, "manual", now.toISOString());
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) return null;
    throw error;
  }

  void processReadwiseSync(database, client, {
    ...options,
    now,
    runId,
  });

  return runId;
}

export async function processReadwiseSync(
  database: Database,
  client: ReadwiseClient,
  options: StartSyncOptions & { now?: Date; runId: number },
): Promise<SyncResult | null> {
  const now = options.now ?? new Date();
  const ingestionWindowHours =
    options.ingestionWindowHours ?? readIngestionWindowHours();
  const updatedAfter = new Date(
    now.getTime() - ingestionWindowHours * 60 * 60 * 1000,
  ).toISOString();

  try {
    const documents = await client.listDocuments({ updatedAfter });
    const syncResult = persistSyncCandidates(database, documents, {
      ...options,
      now,
      ingestionWindowHours,
      runId: options.runId,
    });

    if (options.evaluate) {
      const evaluation = await options.evaluate(documents, now);
      database
        .query(
          `UPDATE sync_runs
           SET items_processed = ?, items_failed = ?
           WHERE id = ?`,
        )
        .run(evaluation.itemsProcessed, evaluation.itemsFailed, options.runId);
    }

    if (options.youtubeSync) {
      const youtubeResult = await options.youtubeSync(now);
      database
        .query(
          `UPDATE sync_runs
           SET items_processed = items_processed + ?,
               items_failed = items_failed + ?
           WHERE id = ?`,
        )
        .run(
          youtubeResult.itemsProcessed,
          youtubeResult.itemsFailed,
          options.runId,
        );
    }

    if (options.mediastackSync) {
      const mediastackResult = await options.mediastackSync(now);
      database
        .query(
          `UPDATE sync_runs
           SET items_processed = items_processed + ?,
               items_failed = items_failed + ?
           WHERE id = ?`,
        )
        .run(
          mediastackResult.itemsProcessed,
          mediastackResult.itemsFailed,
          options.runId,
        );
    }

    if (options.redditSync) {
      const redditResult = await options.redditSync(now);
      database
        .query(
          `UPDATE sync_runs
           SET items_processed = items_processed + ?,
               items_failed = items_failed + ?
           WHERE id = ?`,
        )
        .run(
          redditResult.itemsProcessed,
          redditResult.itemsFailed,
          options.runId,
        );
    }

    if (options.githubTrendingSync) {
      const githubResult = await options.githubTrendingSync(now);
      database
        .query(
          `UPDATE sync_runs
           SET items_processed = items_processed + ?,
               items_failed = items_failed + ?
           WHERE id = ?`,
        )
        .run(
          githubResult.itemsProcessed,
          githubResult.itemsFailed,
          options.runId,
        );
    }

    return syncResult;
  } catch (error) {
    failSyncRun(database, options.runId, safeSyncErrorMessage(error));
    return null;
  }
}

export function readIngestionWindowHours(
  value = process.env.INGESTION_WINDOW_HOURS,
): number {
  if (value === undefined || value.trim() === "") {
    return 12;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("INGESTION_WINDOW_HOURS must be a positive number");
  }

  return parsed;
}

export function createSyncRun(
  database: Database,
  trigger: "manual" | "command",
  startedAt: string,
): number {
  return database.transaction(() => {
    const activeRun = database
      .query<{ id: number }, []>(
        "SELECT id FROM sync_runs WHERE status = 'running' LIMIT 1",
      )
      .get();
    if (activeRun) throw new SyncAlreadyRunningError();

    const result = database
      .query(
        `INSERT INTO sync_runs (trigger, status, started_at)
         VALUES (?, 'running', ?)`,
      )
      .run(trigger, startedAt);

    const run = database
      .query<{ id: number }, [number]>("SELECT id FROM sync_runs WHERE id = ?")
      .get(Number(result.lastInsertRowid));
    if (!run) {
      throw new Error("Sync run was not found after creation");
    }

    return run.id;
  })();
}

export function getSyncRun(
  database: Database,
  runId: number,
): SyncRunRecord | null {
  const row = database
    .query<SyncRunRow, [number]>("SELECT * FROM sync_runs WHERE id = ?")
    .get(runId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    itemsFound: row.items_found,
    itemsPersisted: row.items_persisted,
    itemsSkipped: row.items_skipped,
    itemsProcessed: row.items_processed,
    itemsFailed: row.items_failed,
    errorMessage: row.error_message,
  };
}

export function getLatestSyncRun(database: Database): SyncRunRecord | null {
  const row = database
    .query<{ id: number }, []>(
      "SELECT id FROM sync_runs ORDER BY id DESC LIMIT 1",
    )
    .get();

  return row ? getSyncRun(database, row.id) : null;
}

export function listSyncSkips(
  database: Database,
  runId: number | null,
): SyncSkipRecord[] {
  if (runId === null) {
    return [];
  }

  const rows = database
    .query<
      {
        id: number;
        source_name: string;
        source_item_id: string;
        reason_code: string;
        reason: string;
        created_at: string;
      },
      [number]
    >(
      `SELECT id, source_name, source_item_id, reason_code, reason, created_at
       FROM sync_skips
       WHERE sync_run_id = ?
       ORDER BY id ASC`,
    )
    .all(runId);

  return rows.map((row) => ({
    id: row.id,
    sourceName: row.source_name,
    sourceItemId: row.source_item_id,
    reasonCode: row.reason_code,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export function failSyncRun(
  database: Database,
  runId: number,
  errorMessage: string,
): void {
  try {
    database
      .query(
        `UPDATE sync_runs
         SET status = 'failed', finished_at = ?, error_message = ?, items_failed = 1
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), errorMessage, runId);
  } catch (error) {
    console.error(
      `Unable to record failed sync run ${runId}: ${safeSyncErrorMessage(error)}`,
    );
  }
}

function safeSyncErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }

  return "Readwise sync failed";
}

function isSupportedCategory(value: string): value is SupportedCategory {
  return (supportedReadwiseCategories as readonly string[]).includes(value);
}

function toDocumentInput(document: ReadwiseDocument): DocumentInput {
  return {
    sourceName: "rss",
    sourceItemId: document.id,
    readwiseId: document.id,
    sourceUrl: getSafeSourceUrl(document),
    readwiseUrl: document.readwiseUrl,
    title: document.title,
    author: document.author,
    siteName: document.siteName,
    category: document.category,
    publishedDate: document.publishedDate,
    savedAt: document.savedAt,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    createdTimestamp: document.createdAt,
    updatedTimestamp: document.updatedAt,
  };
}

export function getSafeSourceUrl(document: ReadwiseDocument): string | null {
  return safeHttpUrl(document.sourceUrl) ?? safeHttpUrl(document.url);
}
