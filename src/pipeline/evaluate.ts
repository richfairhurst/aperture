import type {
  IntelligenceContext,
  ProviderDocument,
} from "../contracts/providers";
import { filterReadwiseDocuments, getSafeSourceUrl } from "./sync";
import { rankStories, type RankingConfig } from "./rank";
import { enforceTriage, type TriageState } from "./triage";
import type { ReadwiseDocument } from "../providers/readwise";
import { JevClient } from "../providers/jev";
import {
  normalizeHtmlContent,
  normalizeReadwiseDocument,
  type NormalizedContent,
} from "./normalize";
import {
  createNormalizedDocumentVersion,
  upsertDocument,
} from "../repositories/documents";
import {
  findEvaluationForConfiguration,
  findSummaryTarget,
  hasCompletedSummary,
  persistFeedItem,
  persistSummary,
} from "../repositories/feed";
import type { Database } from "bun:sqlite";
import type { SummaryProvider, SummaryRequest } from "../contracts/providers";
import type { YouTubeVideo } from "../providers/youtube";
import type { YouTubeTranscriptClient } from "../providers/youtube-transcript";
import type { MediastackArticle } from "../providers/mediastack";
import type { DocumentInput } from "../repositories/documents";
import { findDocument } from "../repositories/documents";
import { recordMediastackDocumentKeyword } from "../repositories/mediastack";
import { assertHttpUrl } from "../utils/safe-url";

export type EvaluationPipelineOptions = {
  context: IntelligenceContext;
  rubricVersion: string;
  promptVersion: string;
  rankingConfig?: RankingConfig;
  now?: Date;
  ingestionWindowHours?: number;
  summaryProvider?: SummaryProvider;
  summaryPromptVersion?: string;
  summaryMaxPerRun?: number;
  summaryConcurrency?: number;
  summaryRetries?: number;
  summariesInBackground?: boolean;
  sourceName?: string;
};

type SummaryJob = {
  documentVersionId: number;
  document: ProviderDocument;
  priority: number;
};

type SummaryRunResult = {
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
};

export type EvaluationPipelineFailure = {
  sourceItemId: string;
  stage: "normalize" | "evaluate" | "persist";
  message: string;
};

export type EvaluationPipelineResult = {
  itemsFound: number;
  itemsProcessed: number;
  itemsSkipped: number;
  itemsFailed: number;
  evaluationsCreated: number;
  feedItemsCreated: number;
  summariesScheduled: number;
  summariesAttempted: number;
  summariesCompleted: number;
  summariesFailed: number;
  failures: EvaluationPipelineFailure[];
  skipped: Array<{ sourceItemId: string; reason: string }>;
};

export async function processReadwiseDocuments(
  database: Database,
  documents: ReadwiseDocument[],
  jevClient: JevClient,
  options: EvaluationPipelineOptions,
): Promise<EvaluationPipelineResult> {
  const filtered = filterReadwiseDocuments(documents, options);
  const result: EvaluationPipelineResult = {
    itemsFound: documents.length,
    itemsProcessed: 0,
    itemsSkipped: filtered.skipped.length,
    itemsFailed: 0,
    evaluationsCreated: 0,
    feedItemsCreated: 0,
    summariesScheduled: 0,
    summariesAttempted: 0,
    summariesCompleted: 0,
    summariesFailed: 0,
    failures: [],
    skipped: filtered.skipped.map((skip) => ({
      sourceItemId: skip.document.id,
      reason: skip.reason,
    })),
  };

  const summaryJobs: SummaryJob[] = [];
  for (const document of filtered.eligible) {
    const processingResult = await processOneDocument(
      database,
      document,
      jevClient,
      options,
    );

    if (processingResult.kind === "skipped") {
      result.itemsSkipped += 1;
      result.skipped.push({
        sourceItemId: document.id,
        reason: processingResult.reason,
      });
      continue;
    }

    if (processingResult.kind === "failed") {
      result.itemsFailed += 1;
      result.failures.push({
        sourceItemId: document.id,
        stage: processingResult.stage,
        message: processingResult.message,
      });
      continue;
    }

    result.itemsProcessed += 1;
    result.evaluationsCreated += processingResult.evaluationCreated ? 1 : 0;
    result.feedItemsCreated += processingResult.feedItemCreated ? 1 : 0;
    if (processingResult.summaryJob) {
      summaryJobs.push(processingResult.summaryJob);
    }
  }

  if (options.summaryProvider) {
    const promptVersion = options.summaryPromptVersion ?? options.promptVersion;
    const pendingJobs = summaryJobs.filter(
      (job) =>
        !hasCompletedSummary(database, {
          documentVersionId: job.documentVersionId,
          promptVersion,
        }),
    );
    const jobs = pendingJobs
      .sort((left, right) => right.priority - left.priority)
      .slice(
        0,
        options.summaryMaxPerRun ??
          readPositiveInteger(process.env.SUMMARY_MAX_PER_RUN, 20),
      );
    result.summariesScheduled = jobs.length;
    const summaryPromise = runSummaryJobs(database, jobs, options);
    if (options.summariesInBackground) {
      void summaryPromise
        .then((summaryResult) => {
          console.info(
            `Summary batch completed: ${summaryResult.completed} succeeded, ${summaryResult.failed} failed, ${summaryResult.skipped} already complete`,
          );
        })
        .catch((error) => {
          console.error(`Summary batch failed: ${safeMessage(error)}`);
        });
    } else {
      const summaryResult = await summaryPromise;
      result.summariesAttempted = summaryResult.attempted;
      result.summariesCompleted = summaryResult.completed;
      result.summariesFailed = summaryResult.failed;
    }
  }

  return result;
}

export async function processYouTubeDocuments(
  database: Database,
  videos: YouTubeVideo[],
  transcriptClient: Pick<YouTubeTranscriptClient, "retrieve">,
  jevClient: JevClient,
  options: EvaluationPipelineOptions,
): Promise<EvaluationPipelineResult> {
  const result: EvaluationPipelineResult = {
    itemsFound: videos.length,
    itemsProcessed: 0,
    itemsSkipped: 0,
    itemsFailed: 0,
    evaluationsCreated: 0,
    feedItemsCreated: 0,
    summariesScheduled: 0,
    summariesAttempted: 0,
    summariesCompleted: 0,
    summariesFailed: 0,
    failures: [],
    skipped: [],
  };
  const summaryJobs: SummaryJob[] = [];

  for (const video of videos) {
    if (hasPublishedVideo(database, video.id)) continue;
    let transcript;
    try {
      transcript = await transcriptClient.retrieve(video.id);
    } catch (error) {
      result.itemsFailed += 1;
      result.failures.push({
        sourceItemId: video.id,
        stage: "normalize",
        message: safeMessage(error),
      });
      continue;
    }
    if (!transcript.content) {
      result.itemsSkipped += 1;
      result.skipped.push({
        sourceItemId: video.id,
        reason: transcript.reason ?? `Transcript status: ${transcript.status}`,
      });
      continue;
    }

    const providerDocument: ProviderDocument = {
      sourceName: "youtube",
      sourceItemId: video.id,
      title: video.title,
      author: video.channelTitle,
      siteName: "YouTube",
      sourceUrl: video.sourceUrl,
      category: "video",
      publishedDate: video.publishedAt,
      normalizedText: transcript.content.text,
      contentTruncated: false,
    };
    const documentInput: DocumentInput = {
      sourceName: "youtube",
      sourceItemId: video.id,
      readwiseId: null,
      sourceUrl: video.sourceUrl,
      readwiseUrl: null,
      title: video.title,
      author: video.channelTitle,
      siteName: "YouTube",
      category: "video",
      publishedDate: video.publishedAt,
      savedAt: null,
      createdAt: video.publishedAt,
      updatedAt: video.publishedAt,
      createdTimestamp: video.publishedAt,
      updatedTimestamp: video.publishedAt,
    };

    const processingResult = await processNormalizedDocument(
      database,
      documentInput,
      providerDocument,
      transcript.content,
      jevClient,
      options,
    );
    if (processingResult.kind === "processed") {
      result.itemsProcessed += 1;
      result.evaluationsCreated += processingResult.evaluationCreated ? 1 : 0;
      result.feedItemsCreated += processingResult.feedItemCreated ? 1 : 0;
      if (processingResult.summaryJob)
        summaryJobs.push(processingResult.summaryJob);
    } else if (processingResult.kind === "skipped") {
      result.itemsSkipped += 1;
      result.skipped.push({
        sourceItemId: video.id,
        reason: processingResult.reason,
      });
    } else {
      result.itemsFailed += 1;
      result.failures.push({
        sourceItemId: video.id,
        stage: processingResult.stage,
        message: processingResult.message,
      });
    }
  }

  await finishSummaries(database, summaryJobs, result, options);
  return result;
}

function hasPublishedVideo(database: Database, videoId: string): boolean {
  const row = database
    .query<{ present: number }, [string, string]>(
      `SELECT 1 AS present FROM documents d
       JOIN document_versions v ON v.document_id = d.id
       JOIN feed_items f ON f.document_version_id = v.id
       WHERE d.source_name = ? AND d.source_item_id = ?
       LIMIT 1`,
    )
    .get("youtube", videoId);
  return row?.present === 1;
}

export async function processMediastackDocuments(
  database: Database,
  articles: MediastackArticle[],
  jevClient: JevClient,
  options: EvaluationPipelineOptions,
): Promise<EvaluationPipelineResult> {
  const sourceName = options.sourceName ?? "mediastack";
  const result: EvaluationPipelineResult = {
    itemsFound: articles.length,
    itemsProcessed: 0,
    itemsSkipped: 0,
    itemsFailed: 0,
    evaluationsCreated: 0,
    feedItemsCreated: 0,
    summariesScheduled: 0,
    summariesAttempted: 0,
    summariesCompleted: 0,
    summariesFailed: 0,
    failures: [],
    skipped: [],
  };
  const summaryJobs: SummaryJob[] = [];

  for (const article of articles) {
    let normalized: NormalizedContent;
    try {
      normalized = normalizeHtmlContent(
        [article.title, article.content ?? article.description]
          .filter(Boolean)
          .join("\n\n"),
      );
    } catch (error) {
      result.itemsSkipped += 1;
      result.skipped.push({
        sourceItemId: article.id,
        reason: safeMessage(error),
      });
      continue;
    }

    const publishedAt = article.publishedAt;
    const documentInput: DocumentInput = {
      sourceName,
      sourceItemId: article.id,
      readwiseId: null,
      sourceUrl: article.url,
      readwiseUrl: null,
      title: article.title,
      author: article.author,
      siteName: article.source,
      category: article.category ?? "news",
      publishedDate: publishedAt,
      savedAt: null,
      createdAt: publishedAt ?? (options.now ?? new Date()).toISOString(),
      updatedAt: publishedAt ?? (options.now ?? new Date()).toISOString(),
      createdTimestamp:
        publishedAt ?? (options.now ?? new Date()).toISOString(),
      updatedTimestamp:
        publishedAt ?? (options.now ?? new Date()).toISOString(),
    };
    const providerDocument: ProviderDocument = {
      sourceName,
      sourceItemId: article.id,
      title: article.title,
      author: article.author,
      siteName: article.source,
      sourceUrl: article.url,
      category: article.category ?? "news",
      publishedDate: publishedAt,
      normalizedText: normalized.text,
      contentTruncated: false,
    };
    const processingResult = await processNormalizedDocument(
      database,
      documentInput,
      providerDocument,
      normalized,
      jevClient,
      options,
    );
    if (processingResult.kind === "processed") {
      const document = findDocument(database, sourceName, article.id);
      if (document && sourceName === "mediastack")
        recordMediastackDocumentKeyword(database, document.id, article.keyword);
      result.itemsProcessed += 1;
      result.evaluationsCreated += processingResult.evaluationCreated ? 1 : 0;
      result.feedItemsCreated += processingResult.feedItemCreated ? 1 : 0;
      if (processingResult.summaryJob)
        summaryJobs.push(processingResult.summaryJob);
    } else if (processingResult.kind === "skipped") {
      result.itemsSkipped += 1;
      result.skipped.push({
        sourceItemId: article.id,
        reason: processingResult.reason,
      });
    } else {
      result.itemsFailed += 1;
      result.failures.push({
        sourceItemId: article.id,
        stage: processingResult.stage,
        message: processingResult.message,
      });
    }
  }

  await finishSummaries(database, summaryJobs, result, options);
  return result;
}

async function finishSummaries(
  database: Database,
  summaryJobs: SummaryJob[],
  result: EvaluationPipelineResult,
  options: EvaluationPipelineOptions,
): Promise<void> {
  if (!options.summaryProvider) return;
  const promptVersion = options.summaryPromptVersion ?? options.promptVersion;
  const jobs = summaryJobs
    .filter(
      (job) =>
        !hasCompletedSummary(database, {
          documentVersionId: job.documentVersionId,
          promptVersion,
        }),
    )
    .sort((left, right) => right.priority - left.priority)
    .slice(
      0,
      options.summaryMaxPerRun ??
        readPositiveInteger(process.env.SUMMARY_MAX_PER_RUN, 20),
    );
  result.summariesScheduled = jobs.length;
  const summaryResult = await runSummaryJobs(database, jobs, options);
  result.summariesAttempted = summaryResult.attempted;
  result.summariesCompleted = summaryResult.completed;
  result.summariesFailed = summaryResult.failed;
}

async function processNormalizedDocument(
  database: Database,
  documentInput: DocumentInput,
  providerDocument: ProviderDocument,
  normalized: NormalizedContent,
  jevClient: JevClient,
  options: EvaluationPipelineOptions,
): Promise<Awaited<ReturnType<typeof processOneDocument>>> {
  const stableDocument = upsertDocument(database, documentInput).document;
  const version = createNormalizedDocumentVersion(database, {
    documentId: stableDocument.id,
    normalizedText: normalized.text,
    sourceUpdatedTimestamp: documentInput.updatedTimestamp,
    ingestedAt: (options.now ?? new Date()).toISOString(),
  }).version;

  if (
    findEvaluationForConfiguration(database, {
      documentVersionId: version.id,
      rubricVersion: options.rubricVersion,
      profileVersion: options.context.profileVersion,
      promptVersion: options.promptVersion,
    }) !== null
  ) {
    const target = findSummaryTarget(database, {
      documentVersionId: version.id,
      rubricVersion: options.rubricVersion,
      profileVersion: options.context.profileVersion,
      promptVersion: options.promptVersion,
    });
    return {
      kind: "processed",
      evaluationCreated: false,
      feedItemCreated: false,
      summaryJob: target
        ? {
            documentVersionId: version.id,
            document: providerDocument,
            priority: target.evaluation.finalScore,
          }
        : undefined,
    };
  }

  let jevResult;
  try {
    jevResult = await jevClient.evaluate({
      document: providerDocument,
      context: options.context,
      rubricVersion: options.rubricVersion,
      promptVersion: options.promptVersion,
    });
  } catch (error) {
    return { kind: "failed", stage: "evaluate", message: safeMessage(error) };
  }

  try {
    const qualityScore = score(
      jevResult.answers.quality_score,
      "quality_score",
    );
    const personalUtilityScore = score(
      jevResult.answers.personal_utility_score,
      "personal_utility_score",
    );
    const actionabilityScore = score(
      jevResult.answers.actionability_score,
      "actionability_score",
    );
    const proposedState = proposedTriageState(
      personalUtilityScore,
      actionabilityScore,
    );
    const rankedStory = rankStories(
      [
        {
          storyId: providerDocument.sourceItemId,
          qualityScore,
          personalUtilityScore,
          actionabilityScore,
          triageState: proposedState,
          firstPublicAt: null,
          sourcePublishedAt: providerDocument.publishedDate,
        },
      ],
      options.rankingConfig,
    )[0]!;
    const triageDecision = enforceTriage({
      proposedState,
      proposedReason:
        "Initial Jev score-based proposal; deterministic rules applied.",
      personalUtilityScore,
      actionabilityScore,
      strategicImplication: null,
      evidenceStatus: "unverified",
      freshnessStatus: "unverified",
      promotionalSignal: noul(jevResult.answers.primarily_promotional),
      profileMatchSignal: personalUtilityScore >= 3 ? "strong" : "weak",
      duplicate: false,
      consequential: false,
      finalScore: rankedStory.finalScore,
    });
    const feedItem = persistFeedItem(database, {
      documentVersionId: version.id,
      profileVersion: options.context.profileVersion,
      rubricVersion: options.rubricVersion,
      promptVersion: options.promptVersion,
      jev: jevResult,
      rankedStory,
      triageDecision,
      freshnessStatus: "unverified",
      freshnessConfidence: "low",
      evidenceStatus: "unverified",
      sourceCount: 1,
      independentSourceCount: 0,
      createdAt: (options.now ?? new Date()).toISOString(),
    });
    return {
      kind: "processed",
      evaluationCreated: feedItem.evaluationCreated,
      feedItemCreated: feedItem.feedItemCreated,
      summaryJob: {
        documentVersionId: version.id,
        document: providerDocument,
        priority: rankedStory.finalScore,
      },
    };
  } catch (error) {
    return { kind: "failed", stage: "persist", message: safeMessage(error) };
  }
}

async function processOneDocument(
  database: Database,
  document: ReadwiseDocument,
  jevClient: JevClient,
  options: EvaluationPipelineOptions,
): Promise<
  | {
      kind: "processed";
      evaluationCreated: boolean;
      feedItemCreated: boolean;
      summaryJob?: SummaryJob;
    }
  | { kind: "skipped"; reason: string }
  | {
      kind: "failed";
      stage: EvaluationPipelineFailure["stage"];
      message: string;
    }
> {
  const sourceUrl = assertHttpUrl(getSafeSourceUrl(document) ?? "");
  const stableDocument = upsertDocument(database, {
    sourceName: "rss",
    sourceItemId: document.id,
    readwiseId: document.id,
    sourceUrl,
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
  }).document;

  let normalized: ReturnType<typeof normalizeReadwiseDocument>;
  try {
    normalized = normalizeReadwiseDocument(document);
  } catch (error) {
    return { kind: "skipped", reason: safeMessage(error) };
  }

  const version = createNormalizedDocumentVersion(database, {
    documentId: stableDocument.id,
    normalizedText: normalized.text,
    sourceUpdatedTimestamp: document.updatedAt,
    ingestedAt: (options.now ?? new Date()).toISOString(),
  }).version;

  const providerDocument: ProviderDocument = {
    sourceName: "rss",
    sourceItemId: document.id,
    title: document.title,
    author: document.author,
    siteName: document.siteName,
    sourceUrl,
    category: document.category,
    publishedDate: document.publishedDate,
    normalizedText: normalized.text,
    contentTruncated: false,
  };

  if (
    findEvaluationForConfiguration(database, {
      documentVersionId: version.id,
      rubricVersion: options.rubricVersion,
      profileVersion: options.context.profileVersion,
      promptVersion: options.promptVersion,
    }) !== null
  ) {
    const target = findSummaryTarget(database, {
      documentVersionId: version.id,
      rubricVersion: options.rubricVersion,
      profileVersion: options.context.profileVersion,
      promptVersion: options.promptVersion,
    });
    return {
      kind: "processed",
      evaluationCreated: false,
      feedItemCreated: false,
      summaryJob: {
        documentVersionId: version.id,
        document: providerDocument,
        priority: target?.evaluation.finalScore ?? Number.NEGATIVE_INFINITY,
      },
    };
  }

  let jevResult;
  try {
    jevResult = await jevClient.evaluate({
      document: providerDocument,
      context: options.context,
      rubricVersion: options.rubricVersion,
      promptVersion: options.promptVersion,
    });
  } catch (error) {
    return { kind: "failed", stage: "evaluate", message: safeMessage(error) };
  }

  try {
    const qualityScore = score(
      jevResult.answers.quality_score,
      "quality_score",
    );
    const personalUtilityScore = score(
      jevResult.answers.personal_utility_score,
      "personal_utility_score",
    );
    const actionabilityScore = score(
      jevResult.answers.actionability_score,
      "actionability_score",
    );
    const proposedState = proposedTriageState(
      personalUtilityScore,
      actionabilityScore,
    );
    const rankedStory = rankStories(
      [
        {
          storyId: document.id,
          qualityScore,
          personalUtilityScore,
          actionabilityScore,
          triageState: proposedState,
          firstPublicAt: null,
          sourcePublishedAt: document.publishedDate,
        },
      ],
      options.rankingConfig,
    )[0]!;
    const triageDecision = enforceTriage({
      proposedState,
      proposedReason:
        "Initial Jev score-based proposal; deterministic rules applied.",
      personalUtilityScore,
      actionabilityScore,
      strategicImplication: null,
      evidenceStatus: "unverified",
      freshnessStatus: "unverified",
      promotionalSignal: noul(jevResult.answers.primarily_promotional),
      profileMatchSignal: personalUtilityScore >= 3 ? "strong" : "weak",
      duplicate: false,
      consequential: false,
      finalScore: rankedStory.finalScore,
    });
    const feedItem = persistFeedItem(database, {
      documentVersionId: version.id,
      profileVersion: options.context.profileVersion,
      rubricVersion: options.rubricVersion,
      promptVersion: options.promptVersion,
      jev: jevResult,
      rankedStory,
      triageDecision,
      freshnessStatus: "unverified",
      freshnessConfidence: "low",
      evidenceStatus: "unverified",
      sourceCount: 1,
      independentSourceCount: 0,
      createdAt: (options.now ?? new Date()).toISOString(),
    });

    return {
      kind: "processed",
      evaluationCreated: feedItem.evaluationCreated,
      feedItemCreated: feedItem.feedItemCreated,
      summaryJob: {
        documentVersionId: version.id,
        document: providerDocument,
        priority: rankedStory.finalScore,
      },
    };
  } catch (error) {
    return { kind: "failed", stage: "persist", message: safeMessage(error) };
  }
}

async function runSummaryJobs(
  database: Database,
  jobs: SummaryJob[],
  options: EvaluationPipelineOptions,
): Promise<SummaryRunResult> {
  const concurrency =
    options.summaryConcurrency ??
    readPositiveInteger(process.env.SUMMARY_CONCURRENCY, 3);
  const results: Array<"completed" | "failed" | "skipped"> = [];
  let nextJob = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextJob++;
      const job = jobs[index];
      if (!job) return;
      results[index] = await summarizeIfNeeded(database, job, options);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  return {
    attempted: results.filter((result) => result !== "skipped").length,
    completed: results.filter((result) => result === "completed").length,
    failed: results.filter((result) => result === "failed").length,
    skipped: results.filter((result) => result === "skipped").length,
  };
}

async function summarizeIfNeeded(
  database: Database,
  job: SummaryJob,
  options: EvaluationPipelineOptions,
): Promise<"completed" | "failed" | "skipped"> {
  if (!options.summaryProvider) {
    return "skipped";
  }

  const promptVersion = options.summaryPromptVersion ?? options.promptVersion;
  if (
    hasCompletedSummary(database, {
      documentVersionId: job.documentVersionId,
      promptVersion,
    })
  ) {
    return "skipped";
  }

  const target = findSummaryTarget(database, {
    documentVersionId: job.documentVersionId,
    rubricVersion: options.rubricVersion,
    profileVersion: options.context.profileVersion,
    promptVersion: options.promptVersion,
  });
  if (!target) {
    return "skipped";
  }

  const request: SummaryRequest = {
    document: job.document,
    context: options.context,
    evaluation: target.evaluation,
    promptVersion,
  };

  try {
    const result = await summarizeWithRetry(
      options.summaryProvider,
      request,
      options.summaryRetries ??
        readPositiveInteger(process.env.SUMMARY_RETRIES, 2),
    );
    persistSummary(database, {
      feedItemId: target.feedItemId,
      documentVersionId: job.documentVersionId,
      result,
    });
    return "completed";
  } catch (error) {
    // Summary failures leave the evaluated item available as summary_pending.
    console.warn(
      `Summary generation failed for ${job.document.sourceItemId}: ${safeMessage(error)}`,
    );
    return "failed";
  }
}

async function summarizeWithRetry(
  provider: SummaryProvider,
  request: SummaryRequest,
  retries: number,
): Promise<Awaited<ReturnType<SummaryProvider["summarize"]>>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await provider.summarize(request);
    } catch (error) {
      if (attempt >= retries || !isRetryableSummaryError(error)) {
        throw error;
      }
      await delay(500 * 2 ** attempt);
    }
  }
}

function isRetryableSummaryError(error: unknown): boolean {
  if (error instanceof Error && error.name === "OpenAISummaryResponseError") {
    return true;
  }

  if (error instanceof Error && error.name === "OpenAISummaryApiError") {
    const status = (error as Error & { status?: number }).status;
    return status === 429 || (status !== undefined && status >= 500);
  }

  return error instanceof Error && error.message.includes("timed out");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function score(
  answer: { type: string; score?: number } | undefined,
  question: string,
): number {
  if (!answer || answer.type !== "score" || answer.score === undefined) {
    throw new Error(
      `Validated Jev response is missing score answer '${question}'`,
    );
  }

  return answer.score;
}

function noul(answer: { type: string; noul?: number } | undefined): boolean {
  return (
    answer?.type === "noul" && answer.noul !== undefined && answer.noul >= 0.5
  );
}

function proposedTriageState(
  personalUtilityScore: number,
  actionabilityScore: number,
): TriageState {
  if (personalUtilityScore >= 3 && actionabilityScore >= 3) {
    return "read_now";
  }

  if (personalUtilityScore >= 2) {
    return "important_context";
  }

  return "watch";
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Processing failed";
}
