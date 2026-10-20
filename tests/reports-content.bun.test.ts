import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { normalizeReportCandidate } from "../src/reports/normalize";
import { persistNormalizedReport } from "../src/repositories/reports-content";
import type { ReportCandidate } from "../src/reports/domain";

const candidate: ReportCandidate = {
  provenance: {
    collection: "report",
    source: "rosti",
    providerReportId: "rosti-1",
    canonicalUrl: "https://rosti.example/report/1",
    sourcePublishedAt: "2026-10-14T10:00:00Z",
    activityStartAt: null,
    activityEndAt: "2026-10-01T00:00:00Z",
    observedAt: "2026-10-14T12:00:00Z",
    updatedAt: "2026-10-14T11:00:00Z",
    reportYear: 2026,
    reportType: "threat_intelligence",
  },
  title: "Historical campaign report",
  contentHash: null,
};

describe("report content persistence", () => {
  it("persists provenance, historical classification, and idempotent versions", async () => {
    const database = await openDatabase(":memory:");
    const normalized = normalizeReportCandidate(candidate, {
      markdownText: "Observed activity and methodology",
    });
    const first = persistNormalizedReport(
      database,
      normalized,
      new Date("2026-10-14T12:00:00Z"),
    );
    const second = persistNormalizedReport(
      database,
      normalized,
      new Date("2026-10-14T13:00:00Z"),
    );
    expect(first.versionCreated).toBe(true);
    expect(second.versionCreated).toBe(false);
    expect(first.report.temporalClassification).toBe(
      "new_reporting_historical_activity",
    );
    expect(
      database.query("SELECT COUNT(*) AS count FROM reports").get(),
    ).toEqual({ count: 1 });
    expect(
      database.query("SELECT COUNT(*) AS count FROM report_versions").get(),
    ).toEqual({ count: 1 });
    database.close();
  });
});
