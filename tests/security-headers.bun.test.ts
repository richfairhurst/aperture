import { describe, expect, it } from "bun:test";
import { createRequestHandler } from "../src/http/app";

describe("HTTP security headers", () => {
  it("adds security headers and a nonce to the login page", async () => {
    const response = await createRequestHandler()(
      new Request("http://localhost/login"),
    );
    const body = await response.text();
    const csp = response.headers.get("content-security-policy");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/u);

    const nonce = csp?.match(/script-src 'nonce-([^']+)'/u)?.[1];
    expect(nonce).toBeTruthy();
    expect(body).toContain(`<script nonce="${nonce}">`);
  });

  it("adds no-store to API responses", async () => {
    const response = await createRequestHandler()(
      new Request("http://localhost/api/health"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "object-src 'none'",
    );
  });
});
