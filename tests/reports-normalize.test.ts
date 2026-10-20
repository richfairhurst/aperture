import { describe, expect, it } from "vitest";
import {
  normalizeReportCandidate,
  normalizeReportCandidates,
} from "../src/reports/normalize";
import type { ReportCandidate } from "../src/reports/domain";

const candidate: ReportCandidate = {
  provenance: {
    collection: "report",
    source: "github_annual_reports",
    providerReportId: "github:Annual Security Reports/2026/Example.pdf",
    canonicalUrl: "https://example.com/Example.pdf",
    sourceIndexUrl: "https://github.com/example/reports",
    sourcePublishedAt: null,
    activityStartAt: null,
    activityEndAt: null,
    observedAt: "2026-10-14T12:00:00Z",
    updatedAt: null,
    reportYear: 2026,
    reportType: "annual_analysis",
  },
  title: "Example annual report",
  contentHash: null,
};

describe("report normalization", () => {
  it("normalizes Markdown and removes repository front matter", () => {
    const result = normalizeReportCandidate(candidate, {
      markdownText: "---\ntitle: Example\n---\n\n# Findings\r\n\r\nEvidence",
    });
    expect(result.content.normalizedText).toBe("# Findings\n\nEvidence");
    expect(result.content.contentHash).toHaveLength(64);
    expect(result.contentFormat).toBe("markdown");
    expect(result.sourceIndexUrl).toBe("https://github.com/example/reports");
  });

  it("rejects sparse candidates without usable content without stopping others", () => {
    const result = normalizeReportCandidates([
      { candidate },
      { candidate, payload: { markdownText: "Useful report text" } },
    ]);
    expect(result.normalized).toHaveLength(1);
    expect(result.failures).toEqual([
      {
        providerReportId: candidate.provenance.providerReportId,
        message: "Invalid report content: report text is empty",
      },
    ]);
  });

  it("normalizes extracted PDF text while retaining PDF format", () => {
    const result = normalizeReportCandidate(candidate, {
      pdfText: "Extracted PDF findings",
    });
    expect(result.content.normalizedText).toBe("Extracted PDF findings");
    expect(result.contentFormat).toBe("pdf");
  });

  it("rejects a report with a non-HTTP(S) canonical URL", () => {
    expect(() =>
      normalizeReportCandidate(
        {
          ...candidate,
          provenance: {
            ...candidate.provenance,
            canonicalUrl: "javascript:alert(1)",
          },
        },
        { markdownText: "Useful report text" },
      ),
    ).toThrow("Only HTTP(S) URLs are allowed");
  });

  it("drops a non-HTTP(S) source index URL", () => {
    const result = normalizeReportCandidate(
      {
        ...candidate,
        provenance: {
          ...candidate.provenance,
          sourceIndexUrl: "javascript:alert(1)",
        },
      },
      { markdownText: "Useful report text" },
    );

    expect(result.sourceIndexUrl).toBeNull();
  });
});
