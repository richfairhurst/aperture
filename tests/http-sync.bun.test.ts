import { describe, expect, it } from "bun:test";
import { AuthService } from "../src/auth";
import { openDatabase } from "../src/db";
import { createRequestHandler, resolveClientIp } from "../src/http/app";
import { createSyncRun } from "../src/pipeline/sync";

describe("sync run HTTP routes", () => {
  it("resolves the client IP from trusted proxy headers", () => {
    expect(
      resolveClientIp(
        new Request("http://localhost", {
          headers: {
            "cf-connecting-ip": "203.0.113.10",
            "x-forwarded-for": "198.51.100.20, 203.0.113.10",
          },
        }),
      ),
    ).toBe("203.0.113.10");
    expect(
      resolveClientIp(
        new Request("http://localhost", {
          headers: { "x-forwarded-for": "198.51.100.20, 203.0.113.10" },
        }),
      ),
    ).toBe("203.0.113.10");
    expect(resolveClientIp(new Request("http://localhost"))).toBeNull();
  });

  it("returns persisted progress for a sync run", async () => {
    const database = await openDatabase(":memory:");
    const runId = createSyncRun(database, "manual", "2026-10-06T12:00:00.000Z");
    const handler = createRequestHandler({ database });

    const response = await handler(
      new Request(`http://localhost/api/runs/${runId}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: runId,
      status: "running",
      itemsFound: 0,
      itemsPersisted: 0,
      itemsSkipped: 0,
    });
    database.close();
  });

  it("returns 404 for an unknown sync run", async () => {
    const database = await openDatabase(":memory:");
    const handler = createRequestHandler({ database });

    const response = await handler(
      new Request("http://localhost/api/runs/999"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "run_not_found",
      message: "The sync run was not found.",
    });
    database.close();
  });

  it("requires same-origin CSRF protection for authenticated sync", async () => {
    const database = await openDatabase(":memory:");
    const sentLinks: string[] = [];
    let tokenNumber = 0;
    const auth = new AuthService(database, {
      approvedEmail: "rich@example.com",
      accessMode: "allowlist",
      baseUrl: "https://aperture.example.com",
      mailer: {
        sendMagicLink: async (_email, link) => {
          sentLinks.push(link);
        },
      },
      randomToken: () => `token-${++tokenNumber}`,
    });
    await auth.requestMagicLink("rich@example.com", "127.0.0.1");
    const magicToken = new URL(sentLinks[0]!).searchParams.get("token");
    const login = auth.consumeMagicLink(magicToken!);
    if (!login) throw new Error("test login failed");
    const cookie = `aperture_session=${login.sessionToken}; aperture_csrf=${login.csrfToken}`;
    const handler = createRequestHandler({
      auth,
      publicBaseUrl: "https://aperture.example.com",
      startSync: () => 42,
    });

    const missingCsrf = await handler(
      new Request("https://aperture.example.com/api/sync", {
        method: "POST",
        headers: { cookie, origin: "https://aperture.example.com" },
      }),
    );
    expect(missingCsrf.status).toBe(401);

    const valid = await handler(
      new Request("https://aperture.example.com/api/sync", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://aperture.example.com",
          "x-csrf-token": login.csrfToken,
        },
      }),
    );
    expect(valid.status).toBe(202);
    database.close();
  });

  it("rate limits authenticated sync requests per session", async () => {
    const database = await openDatabase(":memory:");
    const auth = new AuthService(database, {
      approvedEmail: "rich@example.com",
      accessMode: "allowlist",
      baseUrl: "https://aperture.example.com",
      mailer: { sendMagicLink: async () => {} },
      randomToken: (() => {
        let tokenNumber = 0;
        return () => `rate-token-${++tokenNumber}`;
      })(),
    });
    await auth.requestMagicLink("rich@example.com", "127.0.0.1");
    const link = auth.consumeMagicLink("rate-token-1");
    if (!link) throw new Error("test login failed");
    const cookie = `aperture_session=${link.sessionToken}; aperture_csrf=${link.csrfToken}`;
    const handler = createRequestHandler({
      auth,
      publicBaseUrl: "https://aperture.example.com",
      startSync: () => 42,
    });

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        handler(
          new Request("https://aperture.example.com/api/sync", {
            method: "POST",
            headers: {
              cookie,
              origin: "https://aperture.example.com",
              "x-csrf-token": link.csrfToken,
            },
          }),
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      202, 202, 202, 429,
    ]);
    database.close();
  });
});
