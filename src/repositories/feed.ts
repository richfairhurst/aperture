import type { Database } from "bun:sqlite";
import { safeHttpUrl } from "../utils/safe-url";
import type { RankedStory } from "../pipeline/rank";
import type {
  EvidenceStatus,
  FreshnessStatus,
  TriageDecision,
} from "../pipeline/triage";
import type {
  ValidatedChoiceAnswer,
  ValidatedJevResponse,
  ValidatedScoreAnswer,
} from "../validation/jev";
import type { SummaryResult } from "../contracts/providers";

export type PersistFeedItemInput = {
  documentVersionId: number;
  profileVersion: string;
  rubricVersion: string;
  promptVersion: string;
  jev: ValidatedJevResponse;
  rankedStory: RankedStory;
  triageDecision: TriageDecision;
  freshnessStatus: FreshnessStatus;
  freshnessConfidence: "high" | "medium" | "low";
  evidenceStatus: EvidenceStatus;
  sourceCount: number;
  independentSourceCount: number;
  createdAt?: string;
};

export type PersistedFeedItem = {
  evaluationId: number;
  triageDecisionId: number;
  feedItemId: number;
  publicationStatus: "published" | "summary_pending";
  evaluationCreated: boolean;
  triageDecisionCreated: boolean;
  feedItemCreated: boolean;
};

export type FeedQuery = {
  sourceName?: string[];
  category?: string[];
  timeWindow?: "1h" | "4h" | "1d";
  topic?: string[];
  contentType?: string[];
  triageState?: Array<"read_now" | "important_context" | "watch" | "archive">;
  minimumQuality?: number;
  minimumUtility?: number;
  minimumFinalScore?: number;
  limit?: number;
  cursor?: string;
  sort?: "score" | "recent";
};

export type FeedPage = {
  stories: FeedStory[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type FeedStory = {
  id: number;
  documentVersionId: number;
  title: string;
  author: string | null;
  siteName: string | null;
  sourceName: string;
  sourceUrl: string | null;
  category: string;
  createdAt: string;
  publishedDate: string | null;
  qualityScore: number;
  personalUtilityScore: number;
  actionabilityScore: number;
  finalScore: number;
  primaryTopic: string;
  contentType: string;
  publicationStatus: "published" | "summary_pending" | "withdrawn";
  triageState: "read_now" | "important_context" | "watch" | "archive";
  triageReasonCode: string;
  triageReason: string;
  freshnessStatus: string;
  freshnessConfidence: string;
  evidenceStatus: string;
  sourceCount: number;
  independentSourceCount: number;
  summary: FeedSummary | null;
  noulResults: Record<string, number>;
  probabilities: Record<string, unknown>;
  confidence: Record<string, number>;
};

export type FeedSummary = {
  summary: string;
  whyItMatters: string;
  keyPoints: string[];
  recommendedAction: string | null;
};

type FeedStoryRow = {
  id: number;
  document_version_id: number;
  title: string;
  author: string | null;
  site_name: string | null;
  source_name: string;
  source_url: string;
  category: string;
  created_at: string;
  published_date: string | null;
  quality_score: number;
  personal_utility_score: number;
  actionability_score: number;
  final_score: number;
  primary_topic: string;
  content_type: string;
  publication_status: "published" | "summary_pending" | "withdrawn";
  triage_state: "read_now" | "important_context" | "watch" | "archive";
  triage_reason_code: string;
  triage_reason: string;
  freshness_status: string;
  freshness_confidence: string;
  evidence_status: string;
  source_count: number;
  independent_source_count: number;
  noul_results_json: string;
  probabilities_json: string;
  confidence_json: string;
  summary_status: "pending" | "completed" | "failed" | null;
  summary: string | null;
  why_it_matters: string | null;
  key_points_json: string | null;
  recommended_action: string | null;
};

export function findEvaluationId(
  database: Database,
  input: {
    documentVersionId: number;
    rubricVersion: string;
    profileVersion: string;
    jevModel: string;
    promptVersion: string;
  },
): number | null {
  const evaluation = database
    .query<EvaluationRow, [number, string, string, string, string]>(
      `SELECT id FROM evaluations
       WHERE document_version_id = ?
         AND rubric_version = ?
         AND profile_version = ?
         AND jev_model = ?
         AND prompt_version = ?`,
    )
    .get(
      input.documentVersionId,
      input.rubricVersion,
      input.profileVersion,
      input.jevModel,
      input.promptVersion,
    );

  return evaluation?.id ?? null;
}

export function listFeedStories(
  database: Database,
  query: FeedQuery = {},
): FeedStory[] {
  return listFeedStoryPage(database, query).stories;
}

export function listFeedStoryPage(
  database: Database,
  query: FeedQuery = {},
): FeedPage {
  const limit = query.limit ?? 50;
  const sort = query.sort ?? "score";
  if (sort !== "score" && sort !== "recent") {
    throw new Error("Feed sort must be score or recent");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Feed limit must be an integer from 1 to 200");
  }

  const cursor = query.cursor
    ? decodeFeedCursor(query.cursor, sort)
    : undefined;

  const conditions = ["f.publication_status = 'published'"];
  const parameters: Array<string | number> = [];
  const dateExpression =
    "CASE WHEN d.published_date IS NULL OR length(d.published_date) <= 10 THEN d.created_at ELSE d.published_date END";
  if (query.sourceName?.length) {
    conditions.push(
      `d.source_name IN (${query.sourceName.map(() => "?").join(", ")})`,
    );
    parameters.push(...query.sourceName);
  }
  if (query.category?.length) {
    conditions.push(
      `d.category IN (${query.category.map(() => "?").join(", ")})`,
    );
    parameters.push(...query.category);
  }
  if (query.timeWindow) {
    const hours = { "1h": 1, "4h": 4, "1d": 24 }[query.timeWindow];
    const now = new Date();
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
    conditions.push(`d.created_at >= ? AND d.created_at <= ?`);
    parameters.push(start.toISOString(), now.toISOString());
  }
  if (query.topic?.length) {
    conditions.push(
      `e.primary_topic IN (${query.topic.map(() => "?").join(", ")})`,
    );
    parameters.push(...query.topic);
  }
  if (query.contentType?.length) {
    conditions.push(
      `e.content_type IN (${query.contentType.map(() => "?").join(", ")})`,
    );
    parameters.push(...query.contentType);
  }
  if (query.triageState?.length) {
    conditions.push(
      `t.triage_state IN (${query.triageState.map(() => "?").join(", ")})`,
    );
    parameters.push(...query.triageState);
  }
  if (query.minimumQuality !== undefined) {
    validateMinimumScore(query.minimumQuality, "minimumQuality");
    conditions.push("e.quality_score >= ?");
    parameters.push(query.minimumQuality);
  }
  if (query.minimumUtility !== undefined) {
    validateMinimumScore(query.minimumUtility, "minimumUtility");
    conditions.push("e.personal_utility_score >= ?");
    parameters.push(query.minimumUtility);
  }
  if (query.minimumFinalScore !== undefined) {
    validateFinalScore(query.minimumFinalScore);
    conditions.push("e.final_score >= ?");
    parameters.push(query.minimumFinalScore);
  }

  if (cursor) {
    if (sort === "score") {
      conditions.push(
        `(e.final_score < ? OR (e.final_score = ? AND ${dateExpression} < ?) OR (e.final_score = ? AND ${dateExpression} = ? AND f.id > ?))`,
      );
      parameters.push(
        cursor.score,
        cursor.score,
        cursor.date,
        cursor.score,
        cursor.date,
        cursor.id,
      );
    } else {
      conditions.push(
        `(${dateExpression} < ? OR (${dateExpression} = ? AND e.final_score < ?) OR (${dateExpression} = ? AND e.final_score = ? AND f.id > ?))`,
      );
      parameters.push(
        cursor.date,
        cursor.date,
        cursor.score,
        cursor.date,
        cursor.score,
        cursor.id,
      );
    }
  }

  parameters.push(limit + 1);
  const rows = database
    .query<FeedStoryRow, Array<string | number>>(
      `SELECT
         f.id,
         f.document_version_id,
          d.title,
          d.author,
          d.site_name,
          d.source_name,
          d.source_url,
         d.category,
         d.created_at,
         d.published_date,
         e.quality_score,
         e.personal_utility_score,
         e.actionability_score,
         e.final_score,
         e.primary_topic,
         e.content_type,
         f.publication_status,
         t.triage_state,
         t.triage_reason_code,
         t.triage_reason,
         f.freshness_status,
         f.freshness_confidence,
         f.evidence_status,
         f.source_count,
         f.independent_source_count,
         e.noul_results_json,
         e.probabilities_json,
         e.confidence_json,
         s.status AS summary_status,
         s.summary,
         s.why_it_matters,
         s.key_points_json,
         s.recommended_action
       FROM feed_items f
       JOIN evaluations e ON e.id = f.evaluation_id
       JOIN triage_decisions t ON t.id = (
         SELECT td.id FROM triage_decisions td
         WHERE td.evaluation_id = e.id
         ORDER BY td.id DESC LIMIT 1
       )
       JOIN document_versions v ON v.id = f.document_version_id
       JOIN documents d ON d.id = v.document_id
       LEFT JOIN summaries s ON s.id = f.summary_id
       WHERE ${conditions.join(" AND ")}
        ORDER BY
          ${sort === "score" ? "e.final_score DESC, COALESCE(d.published_date, d.created_at) DESC" : "COALESCE(d.published_date, d.created_at) DESC, e.final_score DESC"},
          f.id ASC
        LIMIT ?`,
    )
    .all(...parameters);

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows.at(-1);
  return {
    stories: pageRows.map(toFeedStory),
    hasMore,
    nextCursor:
      hasMore && lastRow
        ? encodeFeedCursor({
            sort,
            score: lastRow.final_score,
            date: lastRow.published_date ?? lastRow.created_at,
            id: lastRow.id,
          })
        : null,
  };
}

type FeedCursor = {
  sort: "score" | "recent";
  score: number;
  date: string;
  id: number;
};

function encodeFeedCursor(cursor: FeedCursor): string {
  return encodeURIComponent(JSON.stringify(cursor));
}

function decodeFeedCursor(value: string, sort: "score" | "recent"): FeedCursor {
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<FeedCursor>;
    if (
      parsed.sort !== sort ||
      typeof parsed.score !== "number" ||
      !Number.isFinite(parsed.score) ||
      typeof parsed.date !== "string" ||
      typeof parsed.id !== "number" ||
      !Number.isInteger(parsed.id)
    ) {
      throw new Error();
    }
    return parsed as FeedCursor;
  } catch {
    throw new Error("Feed cursor is invalid");
  }
}

export function findEvaluationForConfiguration(
  database: Database,
  input: {
    documentVersionId: number;
    rubricVersion: string;
    profileVersion: string;
    promptVersion: string;
  },
): number | null {
  const evaluation = database
    .query<EvaluationRow, [number, string, string, string]>(
      `SELECT id FROM evaluations
       WHERE document_version_id = ?
         AND rubric_version = ?
         AND profile_version = ?
         AND prompt_version = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(
      input.documentVersionId,
      input.rubricVersion,
      input.profileVersion,
      input.promptVersion,
    );

  return evaluation?.id ?? null;
}

type EvaluationRow = {
  id: number;
};

type TriageDecisionRow = {
  id: number;
};

type FeedItemRow = {
  id: number;
};

export type SummaryTarget = {
  feedItemId: number;
  documentVersionId: number;
  evaluation: {
    primaryTopic: string;
    contentType: string;
    qualityScore: number;
    personalUtilityScore: number;
    actionabilityScore: number;
    finalScore: number;
    triageState: string;
  };
};

export function findSummaryTarget(
  database: Database,
  input: {
    documentVersionId: number;
    rubricVersion: string;
    profileVersion: string;
    promptVersion: string;
  },
): SummaryTarget | null {
  const row = database
    .query<
      {
        feed_item_id: number;
        document_version_id: number;
        primary_topic: string;
        content_type: string;
        quality_score: number;
        personal_utility_score: number;
        actionability_score: number;
        final_score: number;
        triage_state: string;
      },
      [number, string, string, string]
    >(
      `SELECT f.id AS feed_item_id, f.document_version_id,
         e.primary_topic, e.content_type, e.quality_score,
         e.personal_utility_score, e.actionability_score, e.final_score,
         f.triage_state
       FROM feed_items f
       JOIN evaluations e ON e.id = f.evaluation_id
       WHERE f.document_version_id = ?
         AND e.rubric_version = ?
         AND e.profile_version = ?
         AND e.prompt_version = ?
         AND f.triage_state != 'archive'
       ORDER BY f.id DESC
       LIMIT 1`,
    )
    .get(
      input.documentVersionId,
      input.rubricVersion,
      input.profileVersion,
      input.promptVersion,
    );

  if (!row) {
    return null;
  }

  return {
    feedItemId: row.feed_item_id,
    documentVersionId: row.document_version_id,
    evaluation: {
      primaryTopic: row.primary_topic,
      contentType: row.content_type,
      qualityScore: row.quality_score,
      personalUtilityScore: row.personal_utility_score,
      actionabilityScore: row.actionability_score,
      finalScore: row.final_score,
      triageState: row.triage_state,
    },
  };
}

export function persistSummary(
  database: Database,
  input: {
    feedItemId: number;
    documentVersionId: number;
    result: SummaryResult;
  },
): { summaryId: number; created: boolean } {
  const existing = database
    .query<{ id: number }, [number, string, string, string]>(
      `SELECT id FROM summaries
       WHERE document_version_id = ?
         AND summary_provider = ?
         AND summary_model = ?
         AND prompt_version = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(
      input.documentVersionId,
      input.result.provider,
      input.result.model,
      input.result.promptVersion,
    );

  if (existing) {
    database
      .query(
        `UPDATE feed_items
         SET summary_id = ?, publication_status = 'published'
         WHERE id = ?`,
      )
      .run(existing.id, input.feedItemId);
    return { summaryId: existing.id, created: false };
  }

  return database.transaction(() => {
    const summary = database
      .query(
        `INSERT INTO summaries (
          document_version_id, summary_provider, summary_model, prompt_version,
          summary, why_it_matters, key_points_json, recommended_action,
          raw_response_json, status, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
      )
      .run(
        input.documentVersionId,
        input.result.provider,
        input.result.model,
        input.result.promptVersion,
        input.result.summary,
        input.result.whyItMatters,
        JSON.stringify(input.result.keyPoints),
        input.result.recommendedAction,
        JSON.stringify(input.result.rawResponse),
        input.result.generatedAt,
      );
    const summaryId = Number(summary.lastInsertRowid);
    database
      .query(
        `UPDATE feed_items
         SET summary_id = ?, publication_status = 'published'
         WHERE id = ?`,
      )
      .run(summaryId, input.feedItemId);
    return { summaryId, created: true };
  })();
}

export function hasCompletedSummary(
  database: Database,
  input: { documentVersionId: number; promptVersion: string },
): boolean {
  const summary = database
    .query<{ id: number }, [number, string]>(
      `SELECT id FROM summaries
       WHERE document_version_id = ?
         AND prompt_version = ?
         AND status = 'completed'
       LIMIT 1`,
    )
    .get(input.documentVersionId, input.promptVersion);

  return summary !== null;
}

export function persistFeedItem(
  database: Database,
  input: PersistFeedItemInput,
): PersistedFeedItem {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const publicationStatus: PersistedFeedItem["publicationStatus"] =
    input.triageDecision.triageState === "archive"
      ? "published"
      : "summary_pending";

  return database.transaction(() => {
    const evaluation = persistEvaluation(database, input, createdAt);
    const triageDecision = persistTriageDecision(
      database,
      input,
      evaluation.id,
      createdAt,
    );
    const feedItem = persistPublication(
      database,
      input,
      evaluation.id,
      publicationStatus,
      createdAt,
    );
    if (evaluation.created && feedItem.created) {
      database
        .query(
          `UPDATE feed_items
           SET publication_status = 'withdrawn'
           WHERE id != ?
             AND document_version_id IN (
               SELECT id FROM document_versions
               WHERE document_id = (
                 SELECT document_id FROM document_versions WHERE id = ?
               )
             )
             AND publication_status != 'withdrawn'`,
        )
        .run(feedItem.id, input.documentVersionId);
    }

    return {
      evaluationId: evaluation.id,
      triageDecisionId: triageDecision.id,
      feedItemId: feedItem.id,
      publicationStatus,
      evaluationCreated: evaluation.created,
      triageDecisionCreated: triageDecision.created,
      feedItemCreated: feedItem.created,
    };
  })();
}

export function withdrawMissingSourceItems(
  database: Database,
  sourceName: string,
  currentSourceItemIds: string[],
): number {
  if (currentSourceItemIds.length === 0) return 0;

  const placeholders = currentSourceItemIds.map(() => "?").join(", ");
  const result = database
    .query(
      `UPDATE feed_items
       SET publication_status = 'withdrawn'
       WHERE publication_status != 'withdrawn'
         AND document_version_id IN (
           SELECT v.id
           FROM document_versions v
           JOIN documents d ON d.id = v.document_id
           WHERE d.source_name = ?
             AND d.source_item_id NOT IN (${placeholders})
         )`,
    )
    .run(sourceName, ...currentSourceItemIds);

  return result.changes;
}

export function withdrawSupersededSourceVersions(
  database: Database,
  sourceName: string,
): number {
  const result = database
    .query(
      `UPDATE feed_items
       SET publication_status = 'withdrawn'
       WHERE publication_status != 'withdrawn'
         AND document_version_id IN (
           SELECT older_version.id
           FROM document_versions older_version
           JOIN documents d ON d.id = older_version.document_id
           WHERE d.source_name = ?
             AND older_version.id < (
               SELECT MAX(newer_version.id)
               FROM feed_items newer_feed
               JOIN document_versions newer_version
                 ON newer_version.id = newer_feed.document_version_id
               WHERE newer_feed.publication_status != 'withdrawn'
                 AND newer_version.document_id = older_version.document_id
             )
         )`,
    )
    .run(sourceName);

  return result.changes;
}

function persistEvaluation(
  database: Database,
  input: PersistFeedItemInput,
  createdAt: string,
): { id: number; created: boolean } {
  const existing = database
    .query<EvaluationRow, [number, string, string, string, string]>(
      `SELECT id FROM evaluations
       WHERE document_version_id = ?
         AND rubric_version = ?
         AND profile_version = ?
         AND jev_model = ?
         AND prompt_version = ?`,
    )
    .get(
      input.documentVersionId,
      input.rubricVersion,
      input.profileVersion,
      input.jev.model,
      input.promptVersion,
    );

  if (existing) {
    return { id: existing.id, created: false };
  }

  const qualityScore = scoreAnswer(input.jev, "quality_score").score;
  const personalUtilityScore = scoreAnswer(
    input.jev,
    "personal_utility_score",
  ).score;
  const actionabilityScore = scoreAnswer(
    input.jev,
    "actionability_score",
  ).score;
  const primaryTopic = choiceAnswer(input.jev, "primary_topic").choice;
  const contentType = choiceAnswer(input.jev, "content_type").choice;
  const noulResults: Record<string, number> = {};
  const probabilities: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};

  for (const [question, answer] of Object.entries(input.jev.answers)) {
    if (answer.type === "noul") {
      noulResults[question] = answer.noul;
    } else {
      probabilities[question] = answer.probabilities;
      confidence[question] = answer.confidence;
    }
  }

  const result = database
    .query(
      `INSERT INTO evaluations (
        document_version_id, rubric_version, profile_version, jev_model,
        prompt_version, quality_score, personal_utility_score,
        actionability_score, final_score, primary_topic, content_type,
        noul_results_json, probabilities_json, confidence_json,
        raw_response_json, jev_usage_json, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.documentVersionId,
      input.rubricVersion,
      input.profileVersion,
      input.jev.model,
      input.promptVersion,
      qualityScore,
      personalUtilityScore,
      actionabilityScore,
      input.rankedStory.finalScore,
      primaryTopic,
      contentType,
      JSON.stringify(noulResults),
      JSON.stringify(probabilities),
      JSON.stringify(confidence),
      JSON.stringify(input.jev.rawResponse),
      JSON.stringify(input.jev.usage),
      createdAt,
    );

  const id = Number(result.lastInsertRowid);
  return { id, created: true };
}

function persistTriageDecision(
  database: Database,
  input: PersistFeedItemInput,
  evaluationId: number,
  createdAt: string,
): { id: number; created: boolean } {
  const existing = database
    .query<TriageDecisionRow, [number]>(
      "SELECT id FROM triage_decisions WHERE evaluation_id = ?",
    )
    .get(evaluationId);
  if (existing) {
    return { id: existing.id, created: false };
  }

  const result = database
    .query(
      `INSERT INTO triage_decisions (
        evaluation_id, proposed_triage_state, proposed_triage_reason,
        triage_state, triage_reason_code, triage_reason,
        enforced_rules_json, profile_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      evaluationId,
      input.triageDecision.proposedState,
      input.triageDecision.proposedReason,
      input.triageDecision.triageState,
      input.triageDecision.triageReasonCode,
      input.triageDecision.triageReason,
      JSON.stringify(input.triageDecision.enforcedRules),
      input.profileVersion,
      createdAt,
    );

  return { id: Number(result.lastInsertRowid), created: true };
}

function persistPublication(
  database: Database,
  input: PersistFeedItemInput,
  evaluationId: number,
  publicationStatus: "published" | "summary_pending",
  createdAt: string,
): { id: number; created: boolean } {
  const existing = database
    .query<FeedItemRow, [number]>(
      "SELECT id FROM feed_items WHERE evaluation_id = ?",
    )
    .get(evaluationId);
  if (existing) {
    return { id: existing.id, created: false };
  }

  const result = database
    .query(
      `INSERT INTO feed_items (
        document_version_id, evaluation_id, summary_id, publication_status,
        triage_state, triage_reason_code, triage_reason, freshness_status,
        freshness_confidence, evidence_status, source_count,
        independent_source_count, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.documentVersionId,
      evaluationId,
      null,
      publicationStatus,
      input.triageDecision.triageState,
      input.triageDecision.triageReasonCode,
      input.triageDecision.triageReason,
      input.freshnessStatus,
      input.freshnessConfidence,
      input.evidenceStatus,
      input.sourceCount,
      input.independentSourceCount,
      createdAt,
    );

  return { id: Number(result.lastInsertRowid), created: true };
}

function choiceAnswer(
  response: ValidatedJevResponse,
  question: string,
): ValidatedChoiceAnswer {
  const answer = response.answers[question];
  if (!answer || answer.type !== "choice") {
    throw new Error(
      `Validated Jev response is missing choice answer '${question}'`,
    );
  }

  return answer;
}

function toFeedStory(row: FeedStoryRow): FeedStory {
  return {
    id: row.id,
    documentVersionId: row.document_version_id,
    title: row.title,
    author: row.author,
    siteName: row.site_name,
    sourceName: row.source_name,
    sourceUrl: safeHttpUrl(row.source_url),
    category: row.category,
    createdAt: row.created_at,
    publishedDate: row.published_date,
    qualityScore: row.quality_score,
    personalUtilityScore: row.personal_utility_score,
    actionabilityScore: row.actionability_score,
    finalScore: row.final_score,
    primaryTopic: row.primary_topic,
    contentType: row.content_type,
    publicationStatus: row.publication_status,
    triageState: row.triage_state,
    triageReasonCode: row.triage_reason_code,
    triageReason: row.triage_reason,
    freshnessStatus: row.freshness_status,
    freshnessConfidence: row.freshness_confidence,
    evidenceStatus: row.evidence_status,
    sourceCount: row.source_count,
    independentSourceCount: row.independent_source_count,
    summary:
      row.summary_status === "completed" &&
      row.summary !== null &&
      row.why_it_matters !== null &&
      row.key_points_json !== null
        ? {
            summary: row.summary,
            whyItMatters: row.why_it_matters,
            keyPoints: parseJsonArray(row.key_points_json),
            recommendedAction: row.recommended_action,
          }
        : null,
    noulResults: parseJsonRecord(row.noul_results_json, {}),
    probabilities: parseJsonRecord(row.probabilities_json, {}),
    confidence: parseJsonRecord(row.confidence_json, {}),
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function parseJsonRecord<T extends Record<string, unknown>>(
  value: string,
  fallback: T,
): T {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMinimumScore(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 4) {
    throw new Error(`${field} must be a number from 0 to 4`);
  }
}

function validateFinalScore(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("minimumFinalScore must be a number from 0 to 100");
  }
}

function scoreAnswer(
  response: ValidatedJevResponse,
  question: string,
): ValidatedScoreAnswer {
  const answer = response.answers[question];
  if (!answer || answer.type !== "score") {
    throw new Error(
      `Validated Jev response is missing score answer '${question}'`,
    );
  }

  return answer;
}
