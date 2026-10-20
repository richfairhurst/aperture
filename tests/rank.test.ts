import { describe, expect, it } from "vitest";
import {
  defaultRankingConfig,
  normalizeScore,
  rankStories,
  type RankableStory,
} from "../src/pipeline/rank";

function story(overrides: Partial<RankableStory> = {}): RankableStory {
  return {
    storyId: "story-1",
    qualityScore: 2,
    personalUtilityScore: 2,
    actionabilityScore: 2,
    triageState: "watch",
    firstPublicAt: "2026-10-06T10:00:00Z",
    sourcePublishedAt: null,
    ...overrides,
  };
}

describe("story ranking", () => {
  it("normalizes Jev scores to a 0-100 scale", () => {
    expect(normalizeScore(0)).toBe(0);
    expect(normalizeScore(2)).toBe(50);
    expect(normalizeScore(4)).toBe(100);
  });

  it("applies the configured quality, utility, and actionability weights", () => {
    const [result] = rankStories([
      story({
        qualityScore: 4,
        personalUtilityScore: 2,
        actionabilityScore: 0,
      }),
    ]);

    expect(result?.normalizedQuality).toBe(100);
    expect(result?.normalizedPersonalUtility).toBe(50);
    expect(result?.normalizedActionability).toBe(0);
    expect(result?.finalScore).toBe(65);
    expect(result?.rankingConfigVersion).toBe("local-v1");
  });

  it("sorts by final score before tie-breakers", () => {
    const results = rankStories([
      story({ storyId: "low", qualityScore: 1 }),
      story({ storyId: "high", qualityScore: 4 }),
    ]);

    expect(results.map((item) => item.storyId)).toEqual(["high", "low"]);
  });

  it("uses triage state, then date, then stable ID for equal scores", () => {
    const results = rankStories([
      story({
        storyId: "watch-new",
        triageState: "watch",
        firstPublicAt: "2026-10-06T12:00:00Z",
      }),
      story({
        storyId: "important-old",
        triageState: "important_context",
        firstPublicAt: "2026-10-06T09:00:00Z",
      }),
      story({
        storyId: "important-new",
        triageState: "important_context",
        firstPublicAt: "2026-10-06T11:00:00Z",
      }),
      story({
        storyId: "important-newer-id-b",
        triageState: "important_context",
        firstPublicAt: "2026-10-06T11:00:00Z",
      }),
      story({
        storyId: "important-newer-id-a",
        triageState: "important_context",
        firstPublicAt: "2026-10-06T11:00:00Z",
      }),
    ]);

    expect(results.map((item) => item.storyId)).toEqual([
      "important-new",
      "important-newer-id-a",
      "important-newer-id-b",
      "important-old",
      "watch-new",
    ]);
  });

  it("prefers a first-public date and places undated stories last", () => {
    const results = rankStories([
      story({
        storyId: "undated",
        firstPublicAt: null,
        sourcePublishedAt: null,
      }),
      story({
        storyId: "published",
        firstPublicAt: null,
        sourcePublishedAt: "2026-10-06T08:00:00Z",
      }),
      story({
        storyId: "first-public",
        firstPublicAt: "2026-10-06T09:00:00Z",
        sourcePublishedAt: "2026-10-06T06:00:00Z",
      }),
    ]);

    expect(results.map((item) => item.storyId)).toEqual([
      "first-public",
      "published",
      "undated",
    ]);
  });

  it("rejects invalid scores and ranking weights", () => {
    expect(() => rankStories([story({ qualityScore: 5 })])).toThrow(
      "qualityScore",
    );
    expect(() =>
      rankStories([story()], {
        ...defaultRankingConfig,
        qualityWeight: 0.5,
      }),
    ).toThrow("sum to 1");
  });
});
