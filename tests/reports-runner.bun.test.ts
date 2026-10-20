import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { runReportDiscovery } from "../src/reports/runner";
import type { ReportDiscoveryClient } from "../src/reports/discovery";

describe("report discovery runner", () => {
  it("normalizes and persists discovered metadata content", async () => {
    const database = await openDatabase(":memory:");
    const client: ReportDiscoveryClient = {
      discover: async () => [
        {
          provenance: {
            collection: "report",
            source: "orkl",
            providerReportId: "orkl-runner-1",
            canonicalUrl: "https://orkl.example/report/1",
            sourcePublishedAt: "2026-10-14T10:00:00Z",
            activityStartAt: null,
            activityEndAt: null,
            observedAt: "2026-10-14T12:00:00Z",
            updatedAt: null,
            reportYear: 2026,
            reportType: "threat_intelligence",
          },
          title: "Runner report",
          contentHash: null,
          metadata: { abstract: "Report abstract content" },
        },
      ],
    };
    const result = await runReportDiscovery(
      database,
      { orkl: client },
      {
        now: new Date("2026-10-14T12:00:00Z"),
        cadenceHours: 24,
        queryWindowHours: 48,
      },
    );
    expect(result).toEqual({ candidatesFound: 1, failuresCount: 0 });
    expect(
      database.query("SELECT COUNT(*) AS count FROM reports").get(),
    ).toEqual({ count: 1 });
    expect(
      database.query("SELECT COUNT(*) AS count FROM report_versions").get(),
    ).toEqual({ count: 1 });
    database.close();
  });
});
