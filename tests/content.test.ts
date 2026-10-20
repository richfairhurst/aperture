import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  defaultMaxContentCharacters,
  prepareNormalizedContent,
  readMaxContentCharacters,
} from "../src/pipeline/content";

describe("normalized content preparation", () => {
  it("hashes unchanged content without truncating it", () => {
    const result = prepareNormalizedContent("Hello world.");

    expect(result).toEqual({
      normalizedText: "Hello world.",
      wordCount: 2,
      contentHash: createHash("sha256")
        .update("Hello world.", "utf8")
        .digest("hex"),
      contentTruncated: false,
    });
  });

  it("keeps complete paragraphs under the character limit", () => {
    const result = prepareNormalizedContent(
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      36,
    );

    expect(result.normalizedText).toBe("First paragraph.\n\nSecond paragraph.");
    expect(result.normalizedText.length).toBeLessThanOrEqual(36);
    expect(result.contentTruncated).toBe(true);
  });

  it("bounds a single oversized paragraph without splitting a word when possible", () => {
    const result = prepareNormalizedContent(
      "This is a very long paragraph that must be bounded safely.",
      24,
    );

    expect(result.normalizedText.length).toBeLessThanOrEqual(24);
    expect(result.normalizedText).toBe("This is a very long");
    expect(result.contentTruncated).toBe(true);
  });

  it("uses the configured default and rejects invalid limits", () => {
    expect(readMaxContentCharacters()).toBe(defaultMaxContentCharacters);
    expect(() => prepareNormalizedContent("text", 0)).toThrow(
      "MAX_CONTENT_CHARACTERS",
    );
    expect(() => readMaxContentCharacters("not-a-number")).toThrow(
      "MAX_CONTENT_CHARACTERS",
    );
  });
});
