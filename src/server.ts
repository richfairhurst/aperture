import { createRequestHandler } from "./http/app";
import { AuthService, createSmtpMailerFromEnv } from "./auth";
import { openDatabase } from "./db";
import { createReadwiseClientFromEnv } from "./providers/readwise";
import { createJevClientFromEnv } from "./providers/jev";
import {
  processMediastackDocuments,
  processReadwiseDocuments,
  processYouTubeDocuments,
} from "./pipeline/evaluate";
import { getLatestSyncRun, startReadwiseSync } from "./pipeline/sync";
import { createOpenAISummaryClientFromEnv } from "./providers/openai-summary";
import { purgeExpiredNews } from "./pipeline/retention";
import { loadLocalConfig } from "./config";
import {
  createYouTubeClientFromEnv,
  discoverYouTubeVideos,
  filterYouTubeVideosByAge,
} from "./providers/youtube";
import { YouTubeTranscriptClient } from "./providers/youtube-transcript";
import {
  createMediastackClientFromEnv,
  filterMediastackArticlesByAge,
} from "./providers/mediastack";
import { RedditClient } from "./providers/reddit";
import { GitHubTrendingClient } from "./providers/github-trending";
import {
  canRunMediastack,
  finishMediastackRun,
  recordMediastackQuery,
  startMediastackRun,
  getMediastackDiagnostics,
} from "./repositories/mediastack";
import {
  withdrawMissingSourceItems,
  withdrawSupersededSourceVersions,
} from "./repositories/feed";
import { getReportDiscoveryDiagnostics } from "./repositories/reports";
import { findReport } from "./repositories/reports-content";
import {
  GitHubAnnualReportsClient,
  OrklReportClient,
  RostiReportClient,
} from "./reports/discovery";
import { runReportDiscovery } from "./reports/runner";
import { evaluateReport } from "./reports/evaluate";
import { persistReportEvaluation } from "./repositories/report-evaluations";
import { CveClient } from "./providers/cves";
import {
  canRunVulnerabilityPoll,
  finishVulnerabilityRun,
  getLatestVulnerabilityRun,
  purgeExpiredVulnerabilities,
  startVulnerabilityRun,
  upsertVulnerability,
} from "./repositories/vulnerabilities";

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const database = await openDatabase();
const accessMode = process.env.AUTH_ACCESS_MODE ?? "allowlist";
if (accessMode !== "allowlist" && accessMode !== "public") {
  throw new Error("AUTH_ACCESS_MODE must be either allowlist or public");
}
const approvedEmail = process.env.AUTH_APPROVED_EMAIL ?? "";
if (accessMode === "allowlist" && !approvedEmail) {
  throw new Error(
    "AUTH_APPROVED_EMAIL is required when starting the hosted application",
  );
}
const auth = new AuthService(database, {
  approvedEmail,
  accessMode,
  baseUrl: process.env.AUTH_BASE_URL ?? `http://localhost:${port}`,
  mailer: createSmtpMailerFromEnv(),
});
const localConfig = await loadLocalConfig();
const retention = purgeExpiredNews(database);
if (retention.documentsDeleted > 0) {
  console.info(
    `News retention removed ${retention.documentsDeleted} expired documents`,
  );
}
const readwiseClient = createReadwiseClientFromEnv();
const jevClient = createJevClientFromEnv();
const summaryClient =
  process.env.SUMMARY_API_KEY || process.env.OPENAI_API_KEY
    ? createOpenAISummaryClientFromEnv()
    : undefined;
const youtubeClient = localConfig.youtube.enabled
  ? createYouTubeClientFromEnv()
  : undefined;
const youtubeTranscriptClient = localConfig.youtube.enabled
  ? new YouTubeTranscriptClient()
  : undefined;
const mediastackClient = localConfig.mediastack.enabled
  ? createMediastackClientFromEnv(localConfig.mediastack.apiKeyEnv)
  : undefined;
const redditClient = localConfig.reddit.enabled
  ? new RedditClient({
      maxItemsPerPoll: localConfig.reddit.maxItemsPerPoll,
      maxDetailFetches: localConfig.reddit.maxDetailFetches,
      requestTimeoutMs: localConfig.reddit.requestTimeoutMs,
      maxResponseBytes: localConfig.reddit.maxResponseBytes,
    })
  : undefined;
const cveClient = localConfig.cves.enabled
  ? new CveClient({
      endpoint: localConfig.cves.endpoint,
      requestTimeoutMs: localConfig.cves.requestTimeoutMs,
      maxResponseBytes: localConfig.cves.maxResponseBytes,
    })
  : undefined;
const githubTrendingClient = localConfig.githubTrending.enabled
  ? new GitHubTrendingClient({
      endpoint: localConfig.githubTrending.endpoint,
      requestTimeoutMs: localConfig.githubTrending.requestTimeoutMs,
      maxResponseBytes: localConfig.githubTrending.maxResponseBytes,
      maxItemsPerPoll: localConfig.githubTrending.maxItemsPerPoll,
      maxDetailFetches: localConfig.githubTrending.maxDetailFetches,
    })
  : undefined;
purgeExpiredVulnerabilities(
  database,
  new Date(Date.now() - localConfig.cves.retentionDays * 86_400_000),
);
const reportClients = localConfig.reports.enabled
  ? {
      orkl: new OrklReportClient({
        endpoint: localConfig.reports.orklEndpoint,
        requestTimeoutMs: localConfig.reports.requestTimeoutMs,
      }),
      rosti: new RostiReportClient(
        process.env[localConfig.reports.rostiApiKeyEnv] ?? "",
        {
          endpoint: localConfig.reports.rostiEndpoint,
          maxDetailFetches: localConfig.reports.maxDetailFetches,
          requestTimeoutMs: localConfig.reports.requestTimeoutMs,
          shouldFetchDetail: (candidate) => {
            const existing = findReport(database, candidate);
            return (
              !existing || existing.updatedAt !== candidate.provenance.updatedAt
            );
          },
        },
      ),
      github: new GitHubAnnualReportsClient({
        owner: localConfig.reports.githubOwner,
        repository: localConfig.reports.githubRepository,
        maxDetailFetches: localConfig.reports.maxDetailFetches,
        requestTimeoutMs: localConfig.reports.requestTimeoutMs,
        shouldFetchDetail: (candidate) => !findReport(database, candidate),
      }),
    }
  : undefined;
const startConfiguredSync = () =>
  startReadwiseSync(database, readwiseClient, {
    ingestionWindowHours: localConfig.ingestionWindowHours,
    evaluate: (documents, now) =>
      processReadwiseDocuments(database, documents, jevClient, {
        context: {
          profileVersion: "profile-v1",
          topics: [
            "ai",
            "cybersecurity",
            "geopolitics",
            "technology_strategy",
            "executive_decision_making",
            "business_opportunity",
          ],
          namedEntities: [],
          currentDecisions: [],
          exclusions: [],
          editorialBrief: "Prioritize practical, decision-relevant analysis.",
        },
        rubricVersion: "rubric-v1",
        promptVersion: "prompt-v2",
        summaryProvider: summaryClient,
        summaryPromptVersion: "summary-v2",
        summariesInBackground: true,
        now,
      }),
    youtubeSync:
      youtubeClient && youtubeTranscriptClient
        ? async (youtubeNow) => {
            const discovered = await discoverYouTubeVideos(
              youtubeClient,
              localConfig.youtube.channelIds,
              localConfig.youtube.maxVideosPerSync,
            );
            const filteredVideos = filterYouTubeVideosByAge(discovered.videos, {
              now: youtubeNow,
              ingestionWindowHours: localConfig.ingestionWindowHours,
            });
            const evaluation = await processYouTubeDocuments(
              database,
              filteredVideos,
              youtubeTranscriptClient,
              jevClient,
              {
                context: {
                  profileVersion: "profile-v1",
                  topics: [
                    "ai",
                    "cybersecurity",
                    "geopolitics",
                    "technology_strategy",
                    "executive_decision_making",
                    "business_opportunity",
                  ],
                  namedEntities: [],
                  currentDecisions: [],
                  exclusions: [],
                  editorialBrief:
                    "Prioritize practical, decision-relevant analysis.",
                },
                rubricVersion: "rubric-v1",
                promptVersion: "prompt-v2",
                summaryProvider: summaryClient,
                summaryPromptVersion: "summary-v2",
                summariesInBackground: true,
                now: youtubeNow,
              },
            );
            return {
              itemsProcessed: evaluation.itemsProcessed,
              itemsFailed: evaluation.itemsFailed + discovered.failures.length,
            };
          }
        : undefined,
    mediastackSync: mediastackClient
      ? async (mediastackNow) => {
          if (
            !canRunMediastack(
              database,
              mediastackNow,
              localConfig.mediastack.cadenceHours,
            )
          ) {
            return { itemsProcessed: 0, itemsFailed: 0 };
          }
          const runId = startMediastackRun(
            database,
            mediastackNow.toISOString(),
          );
          try {
            const queried = await mediastackClient.queryKeywords(
              localConfig.mediastack.keywords,
              localConfig.mediastack.queryWindowHours,
              localConfig.mediastack.queryIntervalSeconds,
              (keyword) =>
                recordMediastackQuery(database, keyword, mediastackNow),
            );
            const articles = filterMediastackArticlesByAge(
              queried.articles,
              mediastackNow,
              localConfig.ingestionWindowHours,
            );
            const evaluation = await processMediastackDocuments(
              database,
              articles,
              jevClient,
              {
                context: {
                  profileVersion: "profile-v1",
                  topics: [
                    "ai",
                    "cybersecurity",
                    "geopolitics",
                    "technology_strategy",
                    "executive_decision_making",
                    "business_opportunity",
                  ],
                  namedEntities: [],
                  currentDecisions: [],
                  exclusions: [],
                  editorialBrief:
                    "Prioritize practical, decision-relevant analysis.",
                },
                rubricVersion: "rubric-v1",
                promptVersion: "prompt-v2",
                summaryProvider: summaryClient,
                summaryPromptVersion: "summary-v2",
                summariesInBackground: true,
                now: mediastackNow,
              },
            );
            finishMediastackRun(database, runId, {
              finishedAt: new Date().toISOString(),
              status: "completed",
              queriesExecuted: queried.queriesExecuted,
              articlesFound: articles.length,
              errorMessage:
                queried.failures.length > 0
                  ? `${queried.failures.length} keyword queries failed`
                  : null,
            });
            return {
              itemsProcessed: evaluation.itemsProcessed,
              itemsFailed: evaluation.itemsFailed + queried.failures.length,
            };
          } catch (error) {
            finishMediastackRun(database, runId, {
              finishedAt: new Date().toISOString(),
              status: "failed",
              queriesExecuted: 0,
              articlesFound: 0,
              errorMessage:
                error instanceof Error
                  ? error.message.slice(0, 500)
                  : "Mediastack sync failed",
            });
            return { itemsProcessed: 0, itemsFailed: 1 };
          }
        }
      : undefined,
    redditSync: redditClient
      ? async (redditNow) => {
          if (
            !redditClient.canPoll(redditNow, localConfig.reddit.cadenceHours)
          ) {
            return { itemsProcessed: 0, itemsFailed: 0 };
          }
          const queried = await redditClient.poll(
            localConfig.reddit.subreddits,
            localConfig.reddit.queryWindowHours,
            redditNow,
          );
          const evaluation = await processMediastackDocuments(
            database,
            queried.items,
            jevClient,
            {
              context: {
                profileVersion: "profile-v1",
                topics: [
                  "ai",
                  "cybersecurity",
                  "geopolitics",
                  "technology_strategy",
                  "executive_decision_making",
                  "business_opportunity",
                ],
                namedEntities: [],
                currentDecisions: [],
                exclusions: [],
                editorialBrief:
                  "Prioritize practical, decision-relevant analysis.",
              },
              rubricVersion: "rubric-v1",
              promptVersion: "prompt-v2",
              summaryProvider: summaryClient,
              summaryPromptVersion: "summary-v2",
              summariesInBackground: true,
              sourceName: "reddit",
              now: redditNow,
            },
          );
          return {
            itemsProcessed: evaluation.itemsProcessed,
            itemsFailed: evaluation.itemsFailed + queried.failures.length,
          };
        }
      : undefined,
    githubTrendingSync: githubTrendingClient
      ? async (githubNow) => {
          if (
            !githubTrendingClient.canPoll(
              githubNow,
              localConfig.githubTrending.cadenceHours,
            )
          ) {
            return { itemsProcessed: 0, itemsFailed: 0 };
          }
          const queried = await githubTrendingClient.poll(githubNow);
          const evaluation = await processMediastackDocuments(
            database,
            queried.projects,
            jevClient,
            {
              context: {
                profileVersion: "profile-v1",
                topics: [
                  "ai",
                  "cybersecurity",
                  "geopolitics",
                  "technology_strategy",
                  "executive_decision_making",
                  "business_opportunity",
                ],
                namedEntities: [],
                currentDecisions: [],
                exclusions: [],
                editorialBrief:
                  "Prioritize practical, decision-relevant analysis.",
              },
              rubricVersion: "rubric-v1",
              promptVersion: "prompt-v2",
              summaryProvider: summaryClient,
              summaryPromptVersion: "summary-v2",
              summariesInBackground: true,
              sourceName: "github_trending",
              now: githubNow,
            },
          );
          if (
            queried.failures.length === 0 &&
            queried.skipped === 0 &&
            queried.projects.length > 0
          ) {
            withdrawMissingSourceItems(
              database,
              "github_trending",
              queried.projects.map((project) => project.id),
            );
            withdrawSupersededSourceVersions(database, "github_trending");
          }
          return {
            itemsProcessed: evaluation.itemsProcessed,
            itemsFailed: evaluation.itemsFailed + queried.failures.length,
          };
        }
      : undefined,
  });
const server = Bun.serve({
  port,
  fetch: createRequestHandler({
    database,
    auth,
    publicBaseUrl: process.env.AUTH_BASE_URL,
    readwiseClient,
    mediastackDiagnostics: () =>
      getMediastackDiagnostics(
        database,
        new Date(),
        localConfig.mediastack.monthlyQueryAllowance,
        localConfig.mediastack.cadenceHours,
      ),
    redditDiagnostics: () => redditClient?.getDiagnostics() ?? null,
    cveDiagnostics: () => ({
      provider: cveClient?.getDiagnostics() ?? null,
      latestRun: getLatestVulnerabilityRun(database),
    }),
    githubTrendingDiagnostics: () =>
      githubTrendingClient?.getDiagnostics() ?? null,
    reportsDiagnostics: () =>
      getReportDiscoveryDiagnostics(
        database,
        new Date(),
        localConfig.reports.cadenceHours,
      ),
    startSync: startConfiguredSync,
  }),
});

const pollingIntervalMilliseconds =
  localConfig.polling.intervalHours * 60 * 60 * 1000;
const runScheduledSources = () => {
  if (getLatestSyncRun(database)?.status !== "running") {
    void startConfiguredSync();
  }
  if (reportClients) {
    void runReportDiscovery(database, reportClients, {
      cadenceHours: localConfig.reports.cadenceHours,
      queryWindowHours: localConfig.reports.queryWindowHours,
      maxRunDurationMs: localConfig.reports.maxRunDurationMs,
      processingConcurrency: localConfig.reports.processingConcurrency,
      evaluate: async (normalized, reportVersionId) => {
        const evaluation = await evaluateReport(
          jevClient,
          {
            sourceName: normalized.candidate.provenance.source,
            sourceItemId: normalized.candidate.provenance.providerReportId,
            title: normalized.candidate.title,
            author: null,
            siteName: normalized.candidate.provenance.source,
            sourceUrl: normalized.candidate.provenance.canonicalUrl,
            category: "report",
            publishedDate: normalized.candidate.provenance.sourcePublishedAt,
            normalizedText: normalized.content.normalizedText,
            contentTruncated: normalized.content.contentTruncated,
          },
          {
            profileVersion: "profile-v1",
            topics: [
              "ai",
              "cybersecurity",
              "geopolitics",
              "technology_strategy",
              "executive_decision_making",
              "business_opportunity",
            ],
            namedEntities: [],
            currentDecisions: [],
            exclusions: [],
            editorialBrief:
              "Prioritize evidence-rich, decision-relevant reports.",
          },
        );
        persistReportEvaluation(database, reportVersionId, evaluation);
      },
      summarize: summaryClient
        ? async (normalized) =>
            summaryClient.summarizeReport({
              document: {
                sourceName: normalized.candidate.provenance.source,
                sourceItemId: normalized.candidate.provenance.providerReportId,
                title: normalized.candidate.title,
                author: null,
                siteName: normalized.candidate.provenance.source,
                sourceUrl: normalized.candidate.provenance.canonicalUrl,
                category: "report",
                publishedDate:
                  normalized.candidate.provenance.sourcePublishedAt,
                normalizedText: normalized.content.normalizedText,
                contentTruncated: normalized.content.contentTruncated,
              },
              context: {
                profileVersion: "profile-v1",
                topics: [
                  "ai",
                  "cybersecurity",
                  "geopolitics",
                  "technology_strategy",
                  "executive_decision_making",
                  "business_opportunity",
                ],
                namedEntities: [],
                currentDecisions: [],
                exclusions: [],
                editorialBrief:
                  "Extract deep intellectual value and decision-relevant wisdom.",
              },
              reportPublicationDate:
                normalized.candidate.provenance.sourcePublishedAt,
              activityStartDate:
                normalized.candidate.provenance.activityStartAt,
              activityEndDate: normalized.candidate.provenance.activityEndAt,
              reportType: normalized.candidate.provenance.reportType,
              activityStatus: "unknown",
            })
        : undefined,
    });
  }
  if (cveClient) void runCvePoll();
};

async function runCvePoll(): Promise<void> {
  const now = new Date();
  if (
    !cveClient ||
    !canRunVulnerabilityPoll(database, now, localConfig.cves.cadenceHours)
  ) {
    return;
  }
  const runId = startVulnerabilityRun(database, now.toISOString());
  const result = await cveClient.poll(localConfig.cves.queryWindowHours, now);
  for (const vulnerability of result.vulnerabilities) {
    upsertVulnerability(database, vulnerability, now.toISOString());
  }
  finishVulnerabilityRun(database, runId, {
    finishedAt: new Date().toISOString(),
    status:
      result.failures.length > 0 && result.vulnerabilities.length === 0
        ? "failed"
        : "completed",
    recordsFound: result.recordsFound,
    recordsStored: result.vulnerabilities.length,
    recordsSkipped: result.recordsSkipped,
    failuresCount: result.failures.length,
    errorMessage: result.failures.length
      ? result.failures.join("; ").slice(0, 500)
      : null,
  });
}
runScheduledSources();
setInterval(runScheduledSources, pollingIntervalMilliseconds);

console.log(`Local MVP server running at ${server.url}`);
