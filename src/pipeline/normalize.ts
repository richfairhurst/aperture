import type { ReadwiseDocument } from "../providers/readwise";

export type NormalizedContent = {
  text: string;
  wordCount: number;
};

export class EmptyContentError extends Error {
  readonly code = "empty_content";

  constructor() {
    super("Document does not contain usable text content");
    this.name = "EmptyContentError";
  }
}

export function normalizeReadwiseDocument(
  document: ReadwiseDocument,
): NormalizedContent {
  return normalizeHtmlContent(document.htmlContent ?? "");
}

export function normalizeHtmlContent(html: string): NormalizedContent {
  const text = htmlToPlainText(html);
  if (text.length === 0) {
    throw new EmptyContentError();
  }

  return {
    text,
    wordCount: text.split(/\s+/u).length,
  };
}

function htmlToPlainText(html: string): string {
  const withBlockBoundaries = html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(
      /<\s*(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu,
      "",
    )
    .replace(
      /<\s*(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu,
      "\n",
    )
    .replace(/<\s*br\s*\/?>/giu, "\n")
    .replace(
      /<\s*\/?\s*(address|article|blockquote|dd|div|dl|dt|figcaption|figure|h[1-6]|li|main|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/giu,
      "\n",
    );

  const withoutTags = withBlockBoundaries.replace(/<[^>]*>/gu, " ");
  const decoded = decodeHtmlEntities(withoutTags).replace(/\r\n?/gu, "\n");
  const lines = decoded
    .split("\n")
    .map((line) =>
      line
        .replace(/[\t ]+/gu, " ")
        .replace(/\s+([,.;:!?])/gu, "$1")
        .trim(),
    )
    .filter((line) => line.length > 0);

  return lines.join("\n\n").trim();
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/giu,
    (entity, valueWithoutDelimiters: string) => {
      const normalizedEntity = valueWithoutDelimiters.toLowerCase();
      if (normalizedEntity.startsWith("#x")) {
        return decodeCodePoint(normalizedEntity.slice(2), 16, entity);
      }

      if (normalizedEntity.startsWith("#")) {
        return decodeCodePoint(normalizedEntity.slice(1), 10, entity);
      }

      return namedEntities[normalizedEntity] ?? entity;
    },
  );
}

function decodeCodePoint(
  value: string,
  radix: number,
  fallback: string,
): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
