import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import {
  canRunMediastack,
  finishMediastackRun,
  getMediastackDiagnostics,
  recordMediastackQuery,
  startMediastackRun,
} from "../src/repositories/mediastack";

describe("Mediastack cadence and diagnostics", () => {
  it("suppresses polling inside the cadence and records keyword usage", async () => {
    const database = await openDatabase(":memory:");
    const startedAt = new Date("2026-10-08T08:00:00Z");
    const runId = startMediastackRun(database, startedAt.toISOString());
    recordMediastackQuery(database, "China", startedAt);
    recordMediastackQuery(database, "Iran", startedAt);
    finishMediastackRun(database, runId, {
      finishedAt: startedAt.toISOString(),
      status: "completed",
      queriesExecuted: 2,
      articlesFound: 4,
    });

    expect(
      canRunMediastack(database, new Date("2026-10-08T20:00:00Z"), 24),
    ).toBe(false);
    expect(
      canRunMediastack(database, new Date("2026-10-09T08:00:00Z"), 24),
    ).toBe(true);
    expect(getMediastackDiagnostics(database, startedAt, 100)).toMatchObject({
      lastSuccessfulRun: "2026-10-08T08:00:00.000Z",
      nextEligibleRun: "2026-10-09T08:00:00.000Z",
      lastRunStatus: "completed",
      monthlyQueryCount: 2,
      monthlyQueryAllowance: 100,
      allowanceExceeded: false,
      keywordQueryCounts: [
        { keyword: "China", queryCount: 1 },
        { keyword: "Iran", queryCount: 1 },
      ],
    });
    database.close();
  });

  it("does not suppress a retry after a failed run", async () => {
    const database = await openDatabase(":memory:");
    const runId = startMediastackRun(database, "2026-10-08T08:00:00Z");
    finishMediastackRun(database, runId, {
      finishedAt: "2026-10-08T08:01:00Z",
      status: "failed",
      queriesExecuted: 1,
      articlesFound: 0,
      errorMessage: "rate limited",
    });

    expect(
      canRunMediastack(database, new Date("2026-10-08T08:02:00Z"), 24),
    ).toBe(true);
    database.close();
  });
});
