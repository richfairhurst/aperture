import { describe, expect, it } from "vitest";
import { createRequestHandler, handleRequest } from "../src/http/app";

describe("local HTTP application", () => {
  it("returns a safe health response", async () => {
    const response = await handleRequest(
      new Request("http://localhost/api/health"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "personal-intelligence-feed-local",
      status: "ok",
    });
  });

  it("serves the local homepage", async () => {
    const response = await handleRequest(new Request("http://localhost/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Personal Intelligence Feed");
  });

  it("returns a safe 404 response", async () => {
    const response = await handleRequest(
      new Request("http://localhost/not-found"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "not_found",
      message: "The requested resource was not found.",
    });
  });

  it("does not expose credentials in the health response", async () => {
    const response = await handleRequest(
      new Request("http://localhost/api/health"),
    );
    const body = await response.text();

    expect(body).not.toContain("TOKEN");
    expect(body).not.toContain("KEY");
    expect(body).not.toContain("SECRET");
  });

  it("starts a sync and returns a run identifier", async () => {
    const handler = createRequestHandler({ startSync: () => 42 });
    const response = await handler(
      new Request("http://localhost/api/sync", { method: "POST" }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: 42, status: "running" });
  });

  it("returns a safe error when sync is not configured", async () => {
    const handler = createRequestHandler();
    const response = await handler(
      new Request("http://localhost/api/sync", { method: "POST" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "sync_unavailable",
      message: "Readwise sync is not configured.",
    });
  });
});
