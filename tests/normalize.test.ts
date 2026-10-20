import { describe, expect, it } from "vitest";
import {
  EmptyContentError,
  normalizeHtmlContent,
  normalizeReadwiseDocument,
} from "../src/pipeline/normalize";
import type { ReadwiseDocument } from "../src/providers/readwise";

function readwiseDocument(htmlContent: string | null): ReadwiseDocument {
  return {
    id: "doc-1",
    url: "https://example.com/article",
    sourceUrl: "https://example.com/article",
    title: "Example article",
    author: null,
    htmlContent,
    category: "article",
    createdAt: "2026-10-06T10:00:00Z",
    updatedAt: "2026-10-06T10:00:00Z",
    publishedDate: null,
    savedAt: null,
    siteName: "Example",
    readwiseUrl: "https://readwise.io/read/doc-1",
    imageUrl: null,
  };
}

describe("content normalization", () => {
  it("converts HTML into readable plain text with paragraph boundaries", () => {
    const result = normalizeHtmlContent(
      "<article><h1>Title</h1><p>First <strong>paragraph</strong>.</p><p>Second<br>line.</p></article>",
    );

    expect(result.text).toBe("Title\n\nFirst paragraph.\n\nSecond\n\nline.");
    expect(result.wordCount).toBe(5);
  });

  it("removes scripts, styles, and navigation noise", () => {
    const result = normalizeHtmlContent(
      "<nav>Home Login</nav><main><p>Useful content.</p><script>alert('x')</script><style>.x{}</style><aside>Related links</aside><footer>Copyright</footer></main>",
    );

    expect(result.text).toBe("Useful content.");
    expect(result.text).not.toContain("Login");
    expect(result.text).not.toContain("alert");
  });

  it("decodes common and numeric HTML entities", () => {
    const result = normalizeHtmlContent(
      "<p>Tom &amp; Jerry &mdash; &#x1F600; &lt;useful&gt;</p>",
    );

    expect(result.text).toBe("Tom & Jerry &mdash; 😀 <useful>");
  });

  it("normalizes a document using its HTML content", () => {
    const result = normalizeReadwiseDocument(
      readwiseDocument("<p>Document content here.</p>"),
    );

    expect(result).toEqual({ text: "Document content here.", wordCount: 3 });
  });

  it("rejects empty, tag-only, and missing content", () => {
    for (const input of ["", "<div><script>noise</script></div>", null]) {
      expect(() =>
        normalizeReadwiseDocument(readwiseDocument(input)),
      ).toThrowError(EmptyContentError);
    }
  });
});
