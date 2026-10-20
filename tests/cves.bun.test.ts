import { describe, expect, it } from "bun:test";
import { openDatabase } from "../src/db";
import { CveClient } from "../src/providers/cves";
import {
  listVulnerabilities,
  upsertVulnerability,
} from "../src/repositories/vulnerabilities";
import { createRequestHandler } from "../src/http/app";

const now = new Date("2026-10-14T12:00:00.000Z");

function fixture() {
  return [
    {
      id: "GHSA-example",
      aliases: ["CVE-2026-12345", "GHSA-example"],
      published: "2026-10-14T10:00:00Z",
      modified: "2026-10-14T11:00:00Z",
      details: "A serious example vulnerability affects the example package.",
      affected: [{ package: { ecosystem: "npm", name: "example-package" } }],
      severity: [
        {
          type: "CVSS_V3",
          score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        },
      ],
      references: [{ type: "ADVISORY", url: "https://example.com/advisory" }],
    },
    {
      id: "CVE-2026-22222",
      published: "2026-10-01T10:00:00Z",
      details: "An old vulnerability outside the configured window.",
    },
  ];
}

describe("CIRCL CVE collection", () => {
  it("normalizes recent records and filters by publication window", async () => {
    const client = new CveClient({
      endpoint: "https://cve.example/recent",
      fetchImpl: async () => new Response(JSON.stringify(fixture())),
    });

    const result = await client.poll(24, now);

    expect(result.failures).toEqual([]);
    expect(result.recordsFound).toBe(2);
    expect(result.recordsSkipped).toBe(1);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0]).toMatchObject({
      cveId: "CVE-2026-12345",
      severity: "critical",
      cvssScore: 9.8,
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      affectedProducts: ["npm: example-package"],
      exploitability: "access N, privileges N",
    });
  });

  it("persists idempotently and serves filtered vulnerability pages", async () => {
    const database = await openDatabase(":memory:");
    const client = new CveClient({
      endpoint: "https://cve.example/recent",
      fetchImpl: async () =>
        new Response(JSON.stringify(fixture().slice(0, 1))),
    });
    const result = await client.poll(24, now);
    const vulnerability = result.vulnerabilities[0];
    if (!vulnerability) throw new Error("fixture did not normalize");
    upsertVulnerability(database, vulnerability, now.toISOString());
    upsertVulnerability(database, vulnerability, now.toISOString());

    expect(
      listVulnerabilities(database, { search: "example-package" }, now)
        .vulnerabilities,
    ).toHaveLength(1);
    expect(
      database.query("SELECT COUNT(*) AS count FROM vulnerabilities").get(),
    ).toEqual({ count: 1 });

    const response = await createRequestHandler({ database })(
      new Request(
        "http://localhost/api/vulnerabilities?search=example-package",
      ),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).vulnerabilities).toHaveLength(1);
    database.close();
  });

  it("filters non-HTTP(S) references before persistence", async () => {
    const database = await openDatabase(":memory:");
    const client = new CveClient({
      endpoint: "https://cve.example/recent",
      fetchImpl: async () =>
        new Response(JSON.stringify(fixture().slice(0, 1))),
    });
    const result = await client.poll(24, now);
    const vulnerability = result.vulnerabilities[0];
    if (!vulnerability) throw new Error("fixture did not normalize");

    upsertVulnerability(
      database,
      {
        ...vulnerability,
        references: [
          "https://example.com/advisory",
          "javascript:alert(1)",
          "data:text/html,<script>",
        ],
      },
      now.toISOString(),
    );

    expect(
      database
        .query<{ references_json: string }, []>(
          "SELECT references_json FROM vulnerabilities",
        )
        .get(),
    ).toEqual({ references_json: '["https://example.com/advisory"]' });
    database.close();
  });

  it("rejects an oversized provider response before parsing it", async () => {
    const client = new CveClient({
      endpoint: "https://cve.example/recent",
      maxResponseBytes: 10,
      fetchImpl: async () =>
        new Response('{"too":"large"}', {
          headers: { "content-length": "100" },
        }),
    });

    const result = await client.poll(24, now);

    expect(result.vulnerabilities).toHaveLength(0);
    expect(result.failures).toEqual([
      "response exceeded configured size limit",
    ]);
  });
});
