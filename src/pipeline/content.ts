import { createHash } from "node:crypto";

export const defaultMaxContentCharacters = 40_000;

export type PreparedContent = {
  normalizedText: string;
  wordCount: number;
  contentHash: string;
  contentTruncated: boolean;
};

export function prepareNormalizedContent(
  normalizedText: string,
  maxCharacters = readMaxContentCharacters(),
): PreparedContent {
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
    throw new Error("MAX_CONTENT_CHARACTERS must be a positive integer");
  }

  const bounded = boundNormalizedText(normalizedText, maxCharacters);

  return {
    normalizedText: bounded.text,
    wordCount: bounded.text.split(/\s+/u).length,
    contentHash: createHash("sha256")
      .update(bounded.text, "utf8")
      .digest("hex"),
    contentTruncated: bounded.truncated,
  };
}

export function readMaxContentCharacters(
  value = process.env.MAX_CONTENT_CHARACTERS,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultMaxContentCharacters;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("MAX_CONTENT_CHARACTERS must be a positive integer");
  }

  return parsed;
}

function boundNormalizedText(
  normalizedText: string,
  maxCharacters: number,
): { text: string; truncated: boolean } {
  if (normalizedText.length <= maxCharacters) {
    return { text: normalizedText, truncated: false };
  }

  const paragraphs = normalizedText.split(/\n{2,}/u);
  const retained: string[] = [];

  for (const paragraph of paragraphs) {
    const candidate = [...retained, paragraph].join("\n\n");
    if (candidate.length > maxCharacters) {
      break;
    }

    retained.push(paragraph);
  }

  if (retained.length > 0) {
    return { text: retained.join("\n\n"), truncated: true };
  }

  return {
    text: truncateSingleParagraph(normalizedText, maxCharacters),
    truncated: true,
  };
}

function truncateSingleParagraph(text: string, maxCharacters: number): string {
  const candidate = text.slice(0, maxCharacters).trimEnd();
  const lastSpace = candidate.lastIndexOf(" ");

  if (lastSpace > 0) {
    return candidate.slice(0, lastSpace);
  }

  return candidate;
}
