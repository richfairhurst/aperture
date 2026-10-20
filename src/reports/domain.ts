export type ReportSource = "orkl" | "rosti" | "github_annual_reports";
export type ReportCollection = "report";

export type ReportType =
  "threat_intelligence" | "annual_analysis" | "survey" | "research" | "other";

export type ReportTemporalClassification =
  | "new_activity"
  | "new_reporting_historical_activity"
  | "updated_report"
  | "annual_edition";

export type ReportProvenance = {
  collection: ReportCollection;
  source: ReportSource;
  providerReportId: string;
  canonicalUrl: string;
  sourceIndexUrl?: string | null;
  sourcePublishedAt: string | null;
  activityStartAt: string | null;
  activityEndAt: string | null;
  observedAt: string;
  updatedAt: string | null;
  reportYear: number | null;
  reportType: ReportType;
};

export type ReportCandidate = {
  provenance: ReportProvenance;
  title: string;
  contentHash: string | null;
  selectedContent?: SelectedReportContent;
  metadata?: Record<string, unknown>;
  contentPayload?: ReportContentPayload;
};

export type ReportContentPayload = {
  markdownText?: string | null;
  pdfText?: string | null;
  pdfBytes?: Uint8Array | null;
};

export type ReportIdentityKeys = {
  canonicalUrl: string;
  contentHash: string | null;
};

export type GitHubReportChange = {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
};

export type GitHubReportContent = {
  pdfUrl: string;
  markdownText: string | null;
};

export type SelectedReportContent = {
  format: "markdown" | "pdf";
  text: string | null;
  authoritativeUrl: string;
};

export function parseReportTimestamp(
  value: string | null | undefined,
): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  if (Date.parse(value) < Date.parse("1970-01-01T00:00:00Z")) return null;
  return value.length === 10
    ? `${value}T00:00:00.000Z`
    : new Date(value).toISOString();
}

export function classifyReportTemporalStatus(input: {
  reportType: ReportType;
  isNewReport: boolean;
  isUpdatedReport: boolean;
  sourcePublishedAt: string | null;
  activityEndAt: string | null;
}): ReportTemporalClassification {
  if (input.isUpdatedReport && !input.isNewReport) return "updated_report";
  if (input.reportType === "annual_analysis" || input.reportType === "survey") {
    return "annual_edition";
  }

  const publishedAt = input.sourcePublishedAt
    ? Date.parse(input.sourcePublishedAt)
    : Number.NaN;
  const activityEndAt = input.activityEndAt
    ? Date.parse(input.activityEndAt)
    : Number.NaN;
  if (
    Number.isFinite(publishedAt) &&
    Number.isFinite(activityEndAt) &&
    activityEndAt < publishedAt
  ) {
    return "new_reporting_historical_activity";
  }

  return "new_activity";
}

export function reportIdentityKeys(
  candidate: ReportCandidate,
): ReportIdentityKeys {
  return {
    canonicalUrl: normalizeCanonicalUrl(candidate.provenance.canonicalUrl),
    contentHash: candidate.contentHash,
  };
}

export function isNewGitHubReportAsset(change: GitHubReportChange): boolean {
  return (
    change.status === "added" &&
    /^Annual Security Reports\/\d{4}\/.*\.pdf$/iu.test(change.path)
  );
}

export function selectGitHubReportContent(
  content: GitHubReportContent,
): SelectedReportContent {
  const markdownText = content.markdownText?.trim();
  if (markdownText) {
    return {
      format: "markdown",
      text: markdownText,
      authoritativeUrl: content.pdfUrl,
    };
  }

  return {
    format: "pdf",
    text: null,
    authoritativeUrl: content.pdfUrl,
  };
}

function normalizeCanonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}
