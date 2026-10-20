import { describe, expect, it } from "vitest";
import {
  assertHttpUrl,
  assertSafePublicUrl,
  safeHttpUrl,
} from "../src/utils/safe-url";

describe("safe HTTP URL handling", () => {
  it("accepts HTTP and HTTPS URLs", () => {
    expect(safeHttpUrl("https://example.com/article")).toBe(
      "https://example.com/article",
    );
    expect(safeHttpUrl("http://example.com/article")).toBe(
      "http://example.com/article",
    );
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>", "//example.com"])(
    "rejects unsafe URL %s",
    (value) => {
      expect(safeHttpUrl(value)).toBeNull();
      expect(() => assertHttpUrl(value)).toThrow(
        "Only HTTP(S) URLs are allowed",
      );
    },
  );

  it.each([
    "http://0.1.2.3/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/",
    "http://2130706433/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://metadata.google.internal/",
  ])("rejects private or metadata URL %s", (value) => {
    expect(() => assertSafePublicUrl(value)).toThrow();
  });
});
