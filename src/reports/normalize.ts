import {
  prepareNormalizedContent,
  type PreparedContent,
} from "../pipeline/content";
import type {
  ReportCandidate,
  ReportContentPayload,
  SelectedReportContent,
} from "./domain";
import { extractPdfText } from "./pdf";
import { assertHttpUrl, safeHttpUrl } from "../utils/safe-url";

export type NormalizedReport = {
  candidate: ReportCandidate;
  sourceIndexUrl: string | null;
  content: PreparedContent;
  contentFormat: "markdown" | "pdf";
  metadata: Record<string, unknown>;
};

export class ReportContentError extends Error {
  constructor(message: string) {
    super(`Invalid report content: ${message}`);
    this.name = "ReportContentError";
  }
}

export function normalizeReportCandidate(
  candidate: ReportCandidate,
  payload: ReportContentPayload = {},
  maxCharacters?: number,
): NormalizedReport {
  assertHttpUrl(candidate.provenance.canonicalUrl);
  const selected = selectContent(candidate, payload);
  const text = normalizeReportText(selected.text);
  if (text === "") {
    throw new ReportContentError("report text is empty");
  }

  return {
    candidate,
    sourceIndexUrl: safeHttpUrl(candidate.provenance.sourceIndexUrl),
    content: prepareNormalizedContent(text, maxCharacters),
    contentFormat: selected.format,
    metadata: {
      ...candidate.metadata,
      collection: candidate.provenance.collection,
      source: candidate.provenance.source,
      providerReportId: candidate.provenance.providerReportId,
      reportType: candidate.provenance.reportType,
      reportYear: candidate.provenance.reportYear,
      title: candidate.title,
    },
  };
}

export async function normalizeReportCandidateWithPdf(
  candidate: ReportCandidate,
  payload: ReportContentPayload = {},
  maxCharacters?: number,
): Promise<NormalizedReport> {
  if (
    !candidate.selectedContent?.text &&
    !payload.markdownText &&
    payload.pdfBytes
  ) {
    const pdfText = await extractPdfText(payload.pdfBytes);
    return normalizeReportCandidate(
      candidate,
      { ...payload, pdfText, pdfBytes: null },
      maxCharacters,
    );
  }
  return normalizeReportCandidate(candidate, payload, maxCharacters);
}

export function normalizeReportCandidates(
  candidates: Array<{
    candidate: ReportCandidate;
    payload?: ReportContentPayload;
  }>,
  maxCharacters?: number,
): {
  normalized: NormalizedReport[];
  failures: Array<{ providerReportId: string; message: string }>;
} {
  const normalized: NormalizedReport[] = [];
  const failures: Array<{ providerReportId: string; message: string }> = [];
  for (const item of candidates) {
    try {
      normalized.push(
        normalizeReportCandidate(item.candidate, item.payload, maxCharacters),
      );
    } catch (error) {
      failures.push({
        providerReportId: item.candidate.provenance.providerReportId,
        message:
          error instanceof Error ? error.message : "Unknown content error",
      });
    }
  }
  return { normalized, failures };
}

function selectContent(
  candidate: ReportCandidate,
  payload: ReportContentPayload,
): SelectedReportContent {
  if (candidate.selectedContent?.text) return candidate.selectedContent;
  const pdfText = payload.pdfText?.trim();
  if (pdfText) {
    return {
      format: "pdf",
      text: pdfText,
      authoritativeUrl: candidate.provenance.canonicalUrl,
    };
  }
  const markdownText = payload.markdownText?.trim();
  if (markdownText) {
    return {
      format: "markdown",
      text: markdownText,
      authoritativeUrl:
        candidate.selectedContent?.authoritativeUrl ??
        candidate.provenance.canonicalUrl,
    };
  }
  if (payload.pdfBytes && payload.pdfBytes.byteLength > 0) {
    throw new ReportContentError(
      "PDF bytes require extraction before normalization",
    );
  }
  const metadataText =
    typeof candidate.metadata?.description === "string"
      ? candidate.metadata.description
      : typeof candidate.metadata?.abstract === "string"
        ? candidate.metadata.abstract
        : null;
  if (metadataText?.trim()) {
    return {
      format: "markdown",
      text: metadataText,
      authoritativeUrl:
        candidate.selectedContent?.authoritativeUrl ??
        candidate.provenance.canonicalUrl,
    };
  }
  return {
    format: "pdf",
    text: null,
    authoritativeUrl:
      candidate.selectedContent?.authoritativeUrl ??
      candidate.provenance.canonicalUrl,
  };
}

function normalizeReportText(value: string | null): string {
  if (!value) return "";
  return value
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
