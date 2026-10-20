export type TriageState =
  "read_now" | "important_context" | "watch" | "archive";

export type RankingConfig = {
  version: string;
  qualityWeight: number;
  personalUtilityWeight: number;
  actionabilityWeight: number;
};

export type RankableStory = {
  storyId: string;
  qualityScore: number;
  personalUtilityScore: number;
  actionabilityScore: number;
  triageState: TriageState;
  firstPublicAt: string | null;
  sourcePublishedAt: string | null;
};

export type RankedStory = RankableStory & {
  rankingConfigVersion: string;
  normalizedQuality: number;
  normalizedPersonalUtility: number;
  normalizedActionability: number;
  finalScore: number;
};

export const defaultRankingConfig: RankingConfig = {
  version: "local-v1",
  qualityWeight: 0.45,
  personalUtilityWeight: 0.4,
  actionabilityWeight: 0.15,
};

const triageOrder: Record<TriageState, number> = {
  read_now: 0,
  important_context: 1,
  watch: 2,
  archive: 3,
};

export function rankStories(
  stories: readonly RankableStory[],
  config: RankingConfig = defaultRankingConfig,
): RankedStory[] {
  validateRankingConfig(config);

  const rankedStories = stories.map((story) => {
    validateScore(story.qualityScore, "qualityScore");
    validateScore(story.personalUtilityScore, "personalUtilityScore");
    validateScore(story.actionabilityScore, "actionabilityScore");

    const normalizedQuality = normalizeScore(story.qualityScore);
    const normalizedPersonalUtility = normalizeScore(
      story.personalUtilityScore,
    );
    const normalizedActionability = normalizeScore(story.actionabilityScore);

    return {
      ...story,
      rankingConfigVersion: config.version,
      normalizedQuality,
      normalizedPersonalUtility,
      normalizedActionability,
      finalScore:
        normalizedQuality * config.qualityWeight +
        normalizedPersonalUtility * config.personalUtilityWeight +
        normalizedActionability * config.actionabilityWeight,
    };
  });

  return rankedStories.sort(compareRankedStories);
}

export function normalizeScore(score: number): number {
  validateScore(score, "score");
  return (score / 4) * 100;
}

function compareRankedStories(a: RankedStory, b: RankedStory): number {
  if (b.finalScore !== a.finalScore) {
    return b.finalScore - a.finalScore;
  }

  const triageDifference =
    triageOrder[a.triageState] - triageOrder[b.triageState];
  if (triageDifference !== 0) {
    return triageDifference;
  }

  const aDate = a.firstPublicAt ?? a.sourcePublishedAt;
  const bDate = b.firstPublicAt ?? b.sourcePublishedAt;
  if (aDate !== bDate) {
    if (aDate === null) return 1;
    if (bDate === null) return -1;
    return bDate.localeCompare(aDate);
  }

  return a.storyId.localeCompare(b.storyId);
}

function validateRankingConfig(config: RankingConfig): void {
  if (config.version.trim().length === 0) {
    throw new Error("Ranking configuration version is required");
  }

  const weights = [
    config.qualityWeight,
    config.personalUtilityWeight,
    config.actionabilityWeight,
  ];
  if (
    weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
    Math.abs(weights.reduce((total, weight) => total + weight, 0) - 1) >
      0.000001
  ) {
    throw new Error("Ranking weights must be non-negative and sum to 1");
  }
}

function validateScore(score: number, field: string): void {
  if (!Number.isFinite(score) || score < 0 || score > 4) {
    throw new Error(`${field} must be a number from 0 to 4`);
  }
}
