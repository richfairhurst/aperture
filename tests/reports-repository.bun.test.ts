import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import {
  canRunReportDiscovery,
  finishReportDiscoveryRun,
  getReportDiscoveryDiagnostics,
  recoverStaleReportDiscoveryRun,
  startReportDiscoveryRun,
  updateReportDiscoveryStage,
} from "../src/repositories/reports";

describe("report discovery diagnostics", () => {
  it("enforces the independent daily cadence", async () => {
    const database = await openDatabase(":memory:");
    const started = "2026-10-14T08:00:00.000Z";
    const runId = startReportDiscoveryRun(database, started);
    finishReportDiscoveryRun(database, runId, {
      finishedAt: "2026-10-14T08:01:00.000Z",
      status: "completed",
      candidatesFound: 3,
      failuresCount: 0,
    });
    expect(
      canRunReportDiscovery(database, new Date("2026-10-14T20:00:00Z"), 24),
    ).toBe(false);
    expect(
      canRunReportDiscovery(database, new Date("2026-10-15T08:01:00Z"), 24),
    ).toBe(true);
    expect(
      getReportDiscoveryDiagnostics(
        database,
        new Date("2026-10-14T20:00:00Z"),
        24,
      ),
    ).toMatchObject({
      nextEligibleRun: "2026-10-15T08:01:00.000Z",
    });
    database.close();
  });

  it("recovers an abandoned running report discovery", async () => {
    const database = await openDatabase(":memory:");
    const runId = startReportDiscoveryRun(database, "2026-10-14T08:00:00.000Z");

    expect(
      recoverStaleReportDiscoveryRun(
        database,
        new Date("2026-10-14T08:05:00.000Z"),
        600_000,
      ),
    ).toBe(false);
    expect(
      recoverStaleReportDiscoveryRun(
        database,
        new Date("2026-10-14T08:20:00.000Z"),
        600_000,
      ),
    ).toBe(true);
    expect(canRunReportDiscovery(database, new Date(), 1)).toBe(true);
    expect(
      getReportDiscoveryDiagnostics(
        database,
        new Date("2026-10-14T08:20:00.000Z"),
        1,
      ),
    ).toMatchObject({ runningForMs: null });
    expect(runId).toBe(1);
    database.close();
  });

  it("exposes the active report source and stage", async () => {
    const database = await openDatabase(":memory:");
    const runId = startReportDiscoveryRun(database, "2026-10-14T08:00:00.000Z");
    updateReportDiscoveryStage(database, runId, "rosti", "processing");

    expect(
      getReportDiscoveryDiagnostics(
        database,
        new Date("2026-10-14T08:05:00.000Z"),
        1,
      ),
    ).toMatchObject({
      currentSource: "rosti",
      currentStage: "processing",
      runningForMs: 300_000,
    });
    database.close();
  });
});
