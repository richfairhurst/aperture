import type { Database } from "bun:sqlite";
import { discoverReports, type ReportDiscoveryClient } from "./discovery";
import {
  canRunReportDiscovery,
  finishReportDiscoveryRun,
  recoverStaleReportDiscoveryRun,
  startReportDiscoveryRun,
  updateReportDiscoveryProgress,
  updateReportDiscoveryStage,
} from "../repositories/reports";
import { persistNormalizedReport } from "../repositories/reports-content";
import { persistReportSummary } from "../repositories/report-summaries";
import {
  normalizeReportCandidateWithPdf,
  type NormalizedReport,
} from "./normalize";
import type { ReportSummaryResult } from "./summary";

export type ReportSummaryRunner = (
  normalized: NormalizedReport,
  reportVersionId: number,
) => Promise<ReportSummaryResult>;

export type ReportEvaluationRunner = (
  normalized: NormalizedReport,
  reportVersionId: number,
) => Promise<void>;

export async function runReportDiscovery(
  database: Database,
  clients: Record<string, ReportDiscoveryClient>,
  options: {
    now?: Date;
    cadenceHours: number;
    queryWindowHours: number;
    maxRunDurationMs?: number;
    processingConcurrency?: number;
    evaluate?: ReportEvaluationRunner;
    summarize?: ReportSummaryRunner;
    summaryRetries?: number;
  },
): Promise<{ candidatesFound: number; failuresCount: number }> {
  const now = options.now ?? new Date();
  const maxRunDurationMs = options.maxRunDurationMs ?? 600_000;
  const runStartedAt = Date.now();
  recoverStaleReportDiscoveryRun(database, now, maxRunDurationMs * 2);
  if (!canRunReportDiscovery(database, now, options.cadenceHours)) {
    return { candidatesFound: 0, failuresCount: 0 };
  }
  const runId = startReportDiscoveryRun(database, now.toISOString());
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    maxRunDurationMs,
  );
  let discoveredCandidates = 0;
  try {
    const result = await discoverReports(clients, {
      since: new Date(now.getTime() - options.queryWindowHours * 3_600_000),
      observedAt: now,
      signal: deadlineController.signal,
      onSourceStage: (source, stage) =>
        updateReportDiscoveryStage(database, runId, source, stage),
    });
    discoveredCandidates = result.candidates.length;
    assertWithinRunDeadline(runStartedAt, maxRunDurationMs);
    updateReportDiscoveryProgress(database, runId, {
      candidatesFound: result.candidates.length,
      failuresCount: result.failures.length,
    });
    let contentFailures = 0;
    updateReportDiscoveryStage(database, runId, null, "processing");
    await runWithConcurrency(
      result.candidates,
      options.processingConcurrency ?? 4,
      async (candidate) => {
        assertWithinRunDeadline(runStartedAt, maxRunDurationMs);
        updateReportDiscoveryStage(
          database,
          runId,
          candidate.provenance.source,
          "processing",
        );
        try {
          const normalized = await normalizeReportCandidateWithPdf(
            candidate,
            candidate.contentPayload,
          );
          const persisted = persistNormalizedReport(database, normalized, now);
          await options.evaluate?.(normalized, persisted.version.id);
          const summary = options.summarize
            ? await summarizeWithRetry(
                options.summarize,
                normalized,
                persisted.version.id,
                options.summaryRetries ?? readSummaryRetries(),
              )
            : undefined;
          if (summary) {
            persistReportSummary(database, persisted.version.id, summary);
          }
        } catch (error) {
          contentFailures += 1;
          console.warn(
            `Report processing failed for ${candidate.provenance.providerReportId}: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      },
    );
    assertWithinRunDeadline(runStartedAt, maxRunDurationMs);
    const failuresCount = result.failures.length + contentFailures;
    clearTimeout(deadlineTimer);
    finishReportDiscoveryRun(database, runId, {
      finishedAt: new Date().toISOString(),
      status: "completed",
      candidatesFound: result.candidates.length,
      failuresCount,
      errorMessage:
        failuresCount > 0
          ? [...result.failures, `${contentFailures} content items failed`]
              .join("; ")
              .slice(0, 500)
          : null,
    });
    return {
      candidatesFound: result.candidates.length,
      failuresCount,
    };
  } catch (error) {
    clearTimeout(deadlineTimer);
    finishReportDiscoveryRun(database, runId, {
      finishedAt: new Date().toISOString(),
      status: "failed",
      candidatesFound: discoveredCandidates,
      failuresCount: 1,
      errorMessage:
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Report discovery failed",
    });
    return { candidatesFound: 0, failuresCount: 1 };
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Report processing concurrency must be a positive integer");
  }
  for (let offset = 0; offset < items.length; offset += concurrency) {
    await Promise.all(items.slice(offset, offset + concurrency).map(worker));
  }
}

function assertWithinRunDeadline(
  startedAt: number,
  maxRunDurationMs: number,
): void {
  if (Date.now() - startedAt >= maxRunDurationMs) {
    throw new Error(`Report discovery exceeded ${maxRunDurationMs}ms`);
  }
}

async function summarizeWithRetry(
  summarize: ReportSummaryRunner,
  normalized: NormalizedReport,
  reportVersionId: number,
  retries: number,
): Promise<ReportSummaryResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await summarize(normalized, reportVersionId);
    } catch (error) {
      if (attempt >= retries || !isRetryableSummaryError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}

function isRetryableSummaryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "OpenAISummaryResponseError") return true;
  if (error.name === "OpenAISummaryApiError") {
    const status = (error as Error & { status?: number }).status;
    return status === 429 || (status !== undefined && status >= 500);
  }
  return error.message.includes("timed out");
}

function readSummaryRetries(): number {
  const value = Number(process.env.SUMMARY_RETRIES ?? 2);
  if (!Number.isInteger(value) || value < 0) return 2;
  return value;
}
