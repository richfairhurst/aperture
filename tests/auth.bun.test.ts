import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../src/db";
import { AuthService, hashSecret } from "../src/auth";

describe("magic-link authentication", () => {
  let database: Database;
  let sentLinks: string[];
  let service: AuthService;

  beforeEach(async () => {
    database = new Database(":memory:");
    await applyMigrations(database);
    sentLinks = [];
    let tokenNumber = 0;
    service = new AuthService(database, {
      approvedEmail: "Rich@Example.com",
      accessMode: "allowlist",
      baseUrl: "https://aperture.example.com",
      mailer: {
        sendMagicLink: async (_email, link) => {
          sentLinks.push(link);
        },
      },
      randomToken: () => `token-${++tokenNumber}`,
    });
  });

  it("sends a generic link only for the approved normalized address", async () => {
    await service.requestMagicLink(" stranger@example.com ", "127.0.0.1");
    await service.requestMagicLink(" RICH@example.com ", "127.0.0.1");

    expect(sentLinks).toHaveLength(1);
    expect(sentLinks[0]).toContain(
      "https://aperture.example.com/api/auth/magic-link/verify",
    );
    expect(sentLinks[0]).toContain("token-1");
  });

  it("consumes a token once and creates a session", async () => {
    await service.requestMagicLink("rich@example.com", "127.0.0.1");
    const token = new URL(sentLinks[0]!).searchParams.get("token");
    expect(token).toBe("token-1");

    const result = service.consumeMagicLink(token!);
    expect(result?.user.email).toBe("rich@example.com");
    expect(service.getSession(result?.sessionToken ?? null)?.user.email).toBe(
      "rich@example.com",
    );
    expect(service.consumeMagicLink(token!)).toBeNull();
  });

  it("stores token and session secrets as hashes", async () => {
    await service.requestMagicLink("rich@example.com", "127.0.0.1");
    const token = new URL(sentLinks[0]!).searchParams.get("token")!;
    expect(
      database
        .query<{ token_hash: string }, []>(
          "SELECT token_hash FROM magic_link_tokens",
        )
        .get()?.token_hash,
    ).toBe(hashSecret(token));
  });

  it("limits repeated requests for an address and IP", async () => {
    for (let index = 0; index < 6; index += 1) {
      await service.requestMagicLink("rich@example.com", "127.0.0.1");
    }
    expect(sentLinks).toHaveLength(5);
  });

  it("allows any valid email in public demo mode", async () => {
    const publicService = new AuthService(database, {
      approvedEmail: "",
      accessMode: "public",
      baseUrl: "https://aperture.example.com",
      mailer: {
        sendMagicLink: async (email, link) => {
          sentLinks.push(`${email}:${link}`);
        },
      },
      randomToken: () => "public-token",
    });

    await publicService.requestMagicLink("visitor@example.com", "127.0.0.2");
    await publicService.requestMagicLink("not-an-email", "127.0.0.3");

    expect(sentLinks).toHaveLength(1);
    expect(sentLinks[0]).toContain("visitor@example.com");
  });
});
