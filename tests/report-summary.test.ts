import { describe, expect, it } from "vitest";
import {
  buildReportSummaryPrompt,
  parseReportSummary,
  reportSummaryJsonSchema,
} from "../src/reports/summary";

const valid = {
  readVerdict: "read_now",
  summary: "A report about cyber resilience and organizational adaptation.",
  oneSentenceSummary:
    "Cyber resilience depends more on adaptation than prevention alone.",
  keyTakeaways: [
    "Evidence-backed takeaway one",
    "Takeaway two",
    "Takeaway three",
  ],
  importantFindings: ["A measured finding"],
  deepInsights: ["Deep insight one", "Deep insight two", "Deep insight three"],
  mentalModels: ["Treat resilience as an adaptation loop."],
  practicalImplications: [
    "Review incident learning",
    "Test decision ownership",
  ],
  recommendations: ["Build feedback loops", "Measure recovery capability"],
  methodologyAndLimitations:
    "The report uses a defined sample but has regional limits.",
  activityContext: "The report studies activity during 2025.",
  quotes: ["Adaptation is continuous."],
  references: ["NIST CSF"],
};

describe("report summaries", () => {
  it("validates the JSON contract and preserves deep intellectual sections", () => {
    expect(parseReportSummary(valid)).toMatchObject({
      readVerdict: "read_now",
      deepInsights: [
        "Deep insight one",
        "Deep insight two",
        "Deep insight three",
      ],
      mentalModels: ["Treat resilience as an adaptation loop."],
    });
    expect(reportSummaryJsonSchema.properties.deepInsights.minItems).toBe(3);
  });

  it("makes evidence, dates, and wisdom extraction explicit in the prompt", () => {
    const prompt = buildReportSummaryPrompt({
      document: {
        sourceName: "report",
        sourceItemId: "r1",
        title: "Report",
        author: null,
        siteName: "Example",
        sourceUrl: "https://example.com/report",
        category: "report",
        publishedDate: "2026-10-14",
        normalizedText: "Report text",
        contentTruncated: false,
      },
      context: {
        profileVersion: "profile-v1",
        topics: ["cybersecurity"],
        namedEntities: [],
        currentDecisions: [],
        exclusions: [],
        editorialBrief: "Prioritize wisdom.",
      },
      reportPublicationDate: "2026-10-14",
      activityStartDate: "2025-01-01",
      activityEndDate: "2025-12-31",
      reportType: "annual_analysis",
      activityStatus: "historical_activity",
    });
    expect(prompt).toContain("deepest intellectual value");
    expect(prompt).toContain("recent publication date or index date");
    expect(prompt).toContain("exact quotes");
  });
});
