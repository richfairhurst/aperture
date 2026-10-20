import { describe, expect, it } from "vitest";
import {
  classifyReportTemporalStatus,
  isNewGitHubReportAsset,
  parseReportTimestamp,
  reportIdentityKeys,
  selectGitHubReportContent,
  type ReportCandidate,
} from "../src/reports/domain";

const candidate: ReportCandidate = {
  provenance: {
    collection: "report",
    source: "orkl",
    providerReportId: "orkl-123",
    canonicalUrl: "https://example.com/report/#section",
    sourcePublishedAt: "2026-10-14T10:00:00Z",
    activityStartAt: null,
    activityEndAt: null,
    observedAt: "2026-10-14T11:00:00Z",
    updatedAt: null,
    reportYear: 2026,
    reportType: "threat_intelligence",
  },
  title: "Example report",
  contentHash: "abc123",
};

describe("report domain", () => {
  it("normalizes full and date-only timestamps while rejecting invalid values", () => {
    expect(parseReportTimestamp("2026-10-14")).toBe("2026-10-14T00:00:00.000Z");
    expect(parseReportTimestamp("2026-10-14T12:30:00-04:00")).toBe(
      "2026-10-14T16:30:00.000Z",
    );
    expect(parseReportTimestamp("not-a-date")).toBeNull();
    expect(parseReportTimestamp("0001-01-01T00:00:00Z")).toBeNull();
    expect(parseReportTimestamp(null)).toBeNull();
  });

  it("classifies historical reporting separately from new activity", () => {
    expect(
      classifyReportTemporalStatus({
        reportType: "threat_intelligence",
        isNewReport: true,
        isUpdatedReport: false,
        sourcePublishedAt: "2026-10-14T10:00:00Z",
        activityEndAt: "2026-09-30T00:00:00Z",
      }),
    ).toBe("new_reporting_historical_activity");
    expect(
      classifyReportTemporalStatus({
        reportType: "threat_intelligence",
        isNewReport: true,
        isUpdatedReport: false,
        sourcePublishedAt: "2026-10-14T10:00:00Z",
        activityEndAt: "2026-10-14T10:00:00Z",
      }),
    ).toBe("new_activity");
  });

  it("prioritizes annual edition and updated-report classifications", () => {
    expect(
      classifyReportTemporalStatus({
        reportType: "annual_analysis",
        isNewReport: true,
        isUpdatedReport: false,
        sourcePublishedAt: null,
        activityEndAt: null,
      }),
    ).toBe("annual_edition");
    expect(
      classifyReportTemporalStatus({
        reportType: "research",
        isNewReport: false,
        isUpdatedReport: true,
        sourcePublishedAt: null,
        activityEndAt: null,
      }),
    ).toBe("updated_report");
  });

  it("creates stable identity keys without URL fragments or tracking queries", () => {
    expect(reportIdentityKeys(candidate)).toEqual({
      canonicalUrl: "https://example.com/report",
      contentHash: "abc123",
    });
  });

  it("accepts only newly added annual report PDFs from GitHub", () => {
    expect(
      isNewGitHubReportAsset({
        path: "Annual Security Reports/2026/Example.pdf",
        status: "added",
      }),
    ).toBe(true);
    expect(
      isNewGitHubReportAsset({
        path: "README.md",
        status: "added",
      }),
    ).toBe(false);
    expect(
      isNewGitHubReportAsset({
        path: "Annual Security Reports/2026/Example.pdf",
        status: "modified",
      }),
    ).toBe(false);
    expect(
      isNewGitHubReportAsset({
        path: "Markdown Conversions/2026/Example.md",
        status: "added",
      }),
    ).toBe(false);
  });

  it("uses Markdown when available and falls back to the authoritative PDF", () => {
    expect(
      selectGitHubReportContent({
        pdfUrl: "https://example.com/report.pdf",
        markdownText: "# Report\n\nFindings",
      }),
    ).toEqual({
      format: "markdown",
      text: "# Report\n\nFindings",
      authoritativeUrl: "https://example.com/report.pdf",
    });
    expect(
      selectGitHubReportContent({
        pdfUrl: "https://example.com/report.pdf",
        markdownText: "  ",
      }),
    ).toEqual({
      format: "pdf",
      text: null,
      authoritativeUrl: "https://example.com/report.pdf",
    });
  });
});
