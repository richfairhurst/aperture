import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  AuthService,
  clearedCsrfCookie,
  clearedSessionCookie,
  csrfCookie,
  readCookie,
  sessionCookie,
} from "../auth";
import {
  getLatestSyncRun,
  getSyncRun,
  listSyncSkips,
  startReadwiseSync,
} from "../pipeline/sync";
import type { ReadwiseClient } from "../providers/readwise";
import { listDocuments } from "../repositories/documents";
import { listFeedStoryPage } from "../repositories/feed";
import { getMediastackDiagnostics } from "../repositories/mediastack";
import { listReportPage } from "../repositories/reports-feed";
import { listVulnerabilities } from "../repositories/vulnerabilities";

const healthResponse = {
  service: "personal-intelligence-feed-local",
  status: "ok",
};

const syncRateLimitWindowMs = 60 * 60 * 1000;
const syncRateLimitMax = 3;
const syncRequestBuckets = new Map<
  string,
  { startedAt: number; count: number }
>();

export type RequestHandlerDependencies = {
  database?: Database;
  auth?: AuthService;
  publicBaseUrl?: string;
  readwiseClient?: ReadwiseClient;
  startSync?: () => number | null;
  mediastackDiagnostics?: () => unknown;
  reportsDiagnostics?: () => unknown;
  redditDiagnostics?: () => unknown;
  reportsNow?: () => Date;
  cveDiagnostics?: () => unknown;
  githubTrendingDiagnostics?: () => unknown;
};

export function createRequestHandler(
  dependencies: RequestHandlerDependencies = {},
): (request: Request) => Promise<Response> {
  return async function handleRequest(request: Request): Promise<Response> {
    const nonce = randomBytes(16).toString("base64");
    const response = await handleRequestWithoutHeaders(request, nonce);
    return withSecurityHeaders(response, request, nonce);
  };

  async function handleRequestWithoutHeaders(
    request: Request,
    nonce: string,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return Response.json(healthResponse);
    }

    if (request.method === "GET" && url.pathname === "/login") {
      const loginPage = await readFile(
        new URL("../../public/login.html", import.meta.url),
        "utf8",
      );
      return new Response(withScriptNonce(loginPage, nonce), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/favicon.svg") {
      const favicon = await readFile(
        new URL("../../public/favicon.svg", import.meta.url),
        "utf8",
      );
      return new Response(favicon, {
        headers: { "content-type": "image/svg+xml; charset=utf-8" },
      });
    }

    if (dependencies.auth && url.pathname.startsWith("/api/auth/")) {
      if (
        request.method === "POST" &&
        url.pathname === "/api/auth/magic-link"
      ) {
        if (!sameOrigin(request, url, dependencies.publicBaseUrl)) {
          return unauthorizedResponse();
        }
        const body = await readJsonBody(request);
        const email = typeof body?.email === "string" ? body.email : "";
        try {
          await dependencies.auth.requestMagicLink(
            email,
            resolveClientIp(request),
          );
        } catch (error) {
          console.error(
            "Magic-link delivery failed",
            error instanceof Error ? error.message : "unknown error",
          );
        }
        return Response.json(
          {
            message: "If the address is valid, a sign-in link is on its way.",
          },
          { status: 202 },
        );
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/auth/magic-link/verify"
      ) {
        const token = url.searchParams.get("token");
        const result = token ? dependencies.auth.consumeMagicLink(token) : null;
        if (!result)
          return new Response("This sign-in link is invalid or expired.", {
            status: 401,
          });
        const secure = isSecureDeployment(url, dependencies.publicBaseUrl);
        return new Response(null, {
          status: 303,
          headers: {
            location: "/",
            "set-cookie": `${sessionCookie(result.sessionToken, secure)}, ${csrfCookie(result.csrfToken, secure)}`,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const sessionToken = readCookie(request, "aperture_session");
        const session = dependencies.auth.getSession(sessionToken);
        if (
          !session ||
          !sameOrigin(request, url, dependencies.publicBaseUrl) ||
          !dependencies.auth.validateCsrf(
            session,
            readCookie(request, "aperture_csrf"),
          )
        )
          return unauthorizedResponse();
        dependencies.auth.revokeSession(sessionToken);
        return new Response(null, {
          status: 204,
          headers: {
            "set-cookie": `${clearedSessionCookie}, ${clearedCsrfCookie}`,
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        const session = dependencies.auth.getSession(
          readCookie(request, "aperture_session"),
        );
        return session
          ? Response.json({ authenticated: true, user: session.user })
          : Response.json({ authenticated: false }, { status: 401 });
      }
    }

    if (dependencies.auth && !isPublicPath(url.pathname)) {
      const session = dependencies.auth.getSession(
        readCookie(request, "aperture_session"),
      );
      if (!session) {
        if (url.pathname.startsWith("/api/")) return unauthorizedResponse();
        return Response.redirect(
          new URL("/login", dependencies.publicBaseUrl ?? url),
          303,
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/diagnostics") {
      return Response.json({
        mediastack: dependencies.mediastackDiagnostics?.() ?? null,
        reports: dependencies.reportsDiagnostics?.() ?? null,
        reddit: dependencies.redditDiagnostics?.() ?? null,
        cves: dependencies.cveDiagnostics?.() ?? null,
        githubTrending: dependencies.githubTrendingDiagnostics?.() ?? null,
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      const homepage = await readFile(
        new URL("../../public/index.html", import.meta.url),
        "utf8",
      );

      return new Response(withScriptNonce(homepage, nonce), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      const sessionToken = readCookie(request, "aperture_session");
      if (dependencies.auth) {
        const session = dependencies.auth.getSession(sessionToken);
        if (
          !session ||
          !sameOrigin(request, url, dependencies.publicBaseUrl) ||
          !dependencies.auth.validateCsrf(
            session,
            request.headers.get("x-csrf-token"),
          )
        ) {
          return unauthorizedResponse();
        }
        if (isSyncRateLimited(sessionToken!)) {
          return Response.json(
            {
              code: "sync_rate_limited",
              message: "Sync requests are temporarily rate limited.",
            },
            { status: 429 },
          );
        }
      }

      if (dependencies.startSync) {
        const runId = dependencies.startSync();
        if (runId === null) return syncAlreadyRunningResponse();
        return Response.json({ runId, status: "running" }, { status: 202 });
      }

      if (!dependencies.database || !dependencies.readwiseClient) {
        return Response.json(
          {
            code: "sync_unavailable",
            message: "Readwise sync is not configured.",
          },
          { status: 503 },
        );
      }

      const runId = startReadwiseSync(
        dependencies.database,
        dependencies.readwiseClient,
      );
      if (runId === null) return syncAlreadyRunningResponse();
      return Response.json({ runId, status: "running" }, { status: 202 });
    }

    if (request.method === "GET" && url.pathname === "/api/documents") {
      if (!dependencies.database) {
        return Response.json(
          {
            code: "database_unavailable",
            message: "The local database is not configured.",
          },
          { status: 503 },
        );
      }

      const requestedLimit = url.searchParams.get("limit");
      const limit = requestedLimit === null ? 100 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return Response.json(
          {
            code: "invalid_limit",
            message: "limit must be an integer from 1 to 200.",
          },
          { status: 400 },
        );
      }

      const latestRun = getLatestSyncRun(dependencies.database);
      return Response.json({
        documents: listDocuments(dependencies.database, limit),
        latestRun,
        skips: listSyncSkips(dependencies.database, latestRun?.id ?? null),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/feed") {
      if (!dependencies.database) {
        return Response.json(
          {
            code: "database_unavailable",
            message: "The local database is not configured.",
          },
          { status: 503 },
        );
      }

      const limit = readQueryNumber(url, "limit");
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const minimumQuality = readQueryNumber(url, "minimumQuality");
      const minimumUtility = readQueryNumber(url, "minimumUtility");
      const minimumFinalScore = readQueryNumber(url, "minimumFinalScore");
      if (
        (limit !== undefined &&
          (!Number.isFinite(limit) ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 200)) ||
        (minimumQuality !== undefined &&
          (!Number.isFinite(minimumQuality) ||
            minimumQuality < 0 ||
            minimumQuality > 4)) ||
        (minimumUtility !== undefined &&
          (!Number.isFinite(minimumUtility) ||
            minimumUtility < 0 ||
            minimumUtility > 4)) ||
        (minimumFinalScore !== undefined &&
          (!Number.isFinite(minimumFinalScore) ||
            minimumFinalScore < 0 ||
            minimumFinalScore > 100))
      ) {
        return Response.json(
          {
            code: "invalid_feed_filter",
            message: "Feed filters contain an invalid limit or score.",
          },
          { status: 400 },
        );
      }

      const triageStates = url.searchParams.getAll("triageState");
      const validTriageStates = [
        "read_now",
        "important_context",
        "watch",
        "archive",
      ];
      if (triageStates.some((state) => !validTriageStates.includes(state))) {
        return Response.json(
          {
            code: "invalid_feed_filter",
            message: "triageState is invalid.",
          },
          { status: 400 },
        );
      }

      const timeWindow = url.searchParams.get("timeWindow") ?? undefined;
      if (timeWindow && !["1h", "4h", "1d"].includes(timeWindow)) {
        return Response.json(
          {
            code: "invalid_feed_filter",
            message: "timeWindow must be 1h, 4h, or 1d.",
          },
          { status: 400 },
        );
      }

      const sort = url.searchParams.get("sort") ?? "score";
      if (sort !== "score" && sort !== "recent") {
        return Response.json(
          {
            code: "invalid_feed_filter",
            message: "sort must be score or recent.",
          },
          { status: 400 },
        );
      }

      try {
        const page = listFeedStoryPage(dependencies.database, {
          sourceName: url.searchParams.getAll("sourceName"),
          category: url.searchParams.getAll("category"),
          timeWindow: timeWindow as "1h" | "4h" | "1d" | undefined,
          topic: url.searchParams.getAll("topic"),
          contentType: url.searchParams.getAll("contentType"),
          triageState: triageStates as Array<
            "read_now" | "important_context" | "watch" | "archive"
          >,
          minimumQuality,
          minimumUtility,
          minimumFinalScore,
          limit,
          cursor,
          sort,
        });
        return Response.json({
          stories: page.stories,
          count: page.stories.length,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        console.error("Feed query failed", error);
        return Response.json(
          {
            code: "invalid_feed_filter",
            message: "Feed query is invalid.",
          },
          { status: 400 },
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/reports") {
      if (!dependencies.database) {
        return Response.json(
          {
            code: "database_unavailable",
            message: "The local database is not configured.",
          },
          { status: 503 },
        );
      }
      const limit = readQueryNumber(url, "limit");
      const yearValue = url.searchParams.get("year");
      const minimumScore = readQueryNumber(url, "minimumScore");
      const observedWithinHours = readQueryNumber(url, "observedWithinHours");
      const sort = url.searchParams.get("sort") ?? "score";
      const year = yearValue === null ? undefined : Number(yearValue);
      if (
        (limit !== undefined &&
          (!Number.isInteger(limit) || limit < 1 || limit > 200)) ||
        (minimumScore !== undefined &&
          (!Number.isFinite(minimumScore) ||
            minimumScore < 0 ||
            minimumScore > 100)) ||
        (observedWithinHours !== undefined &&
          (!Number.isFinite(observedWithinHours) ||
            observedWithinHours <= 0)) ||
        (year !== undefined &&
          (!Number.isInteger(year) || year < 1900 || year > 2200)) ||
        (sort !== "score" && sort !== "recent")
      ) {
        return Response.json(
          {
            code: "invalid_report_filter",
            message: "Report filters contain an invalid value.",
          },
          { status: 400 },
        );
      }
      try {
        const page = listReportPage(
          dependencies.database,
          {
            source: url.searchParams.getAll("source"),
            reportType: url.searchParams.getAll("reportType"),
            topic: url.searchParams.getAll("topic"),
            temporalClassification: url.searchParams.getAll(
              "temporalClassification",
            ),
            year,
            minimumScore,
            observedWithinHours,
            limit,
            cursor: url.searchParams.get("cursor") ?? undefined,
            sort: sort as "score" | "recent",
          },
          dependencies.reportsNow?.() ?? new Date(),
        );
        return Response.json({
          reports: page.reports,
          count: page.reports.length,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        console.error("Report query failed", error);
        return Response.json(
          {
            code: "invalid_report_filter",
            message: "Report query is invalid.",
          },
          { status: 400 },
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/vulnerabilities") {
      if (!dependencies.database) {
        return Response.json(
          {
            code: "database_unavailable",
            message: "The local database is not configured.",
          },
          { status: 503 },
        );
      }
      const limit = readQueryNumber(url, "limit");
      const minimumCvss = readQueryNumber(url, "minimumCvss");
      const publishedWithinHours = readQueryNumber(url, "publishedWithinHours");
      const sort = url.searchParams.get("sort") ?? "severity";
      if (
        (limit !== undefined &&
          (!Number.isInteger(limit) || limit < 1 || limit > 200)) ||
        (minimumCvss !== undefined &&
          (!Number.isFinite(minimumCvss) ||
            minimumCvss < 0 ||
            minimumCvss > 10)) ||
        (publishedWithinHours !== undefined &&
          (!Number.isFinite(publishedWithinHours) ||
            publishedWithinHours <= 0)) ||
        !["severity", "recent", "cvss"].includes(sort)
      ) {
        return Response.json(
          {
            code: "invalid_vulnerability_filter",
            message: "Vulnerability filters contain an invalid value.",
          },
          { status: 400 },
        );
      }
      try {
        const page = listVulnerabilities(dependencies.database, {
          severity: url.searchParams.getAll("severity"),
          minimumCvss,
          publishedWithinHours,
          search: url.searchParams.get("search") ?? undefined,
          sort: sort as "severity" | "recent" | "cvss",
          limit,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        return Response.json({
          vulnerabilities: page.vulnerabilities,
          count: page.vulnerabilities.length,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        console.error("Vulnerability query failed", error);
        return Response.json(
          {
            code: "invalid_vulnerability_filter",
            message: "Vulnerability query is invalid.",
          },
          { status: 400 },
        );
      }
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (request.method === "GET" && runMatch) {
      if (!dependencies.database) {
        return Response.json(
          {
            code: "database_unavailable",
            message: "The local database is not configured.",
          },
          { status: 503 },
        );
      }

      const run = getSyncRun(dependencies.database, Number(runMatch[1]));
      if (!run) {
        return Response.json(
          { code: "run_not_found", message: "The sync run was not found." },
          { status: 404 },
        );
      }

      return Response.json(run);
    }

    return Response.json(
      {
        code: "not_found",
        message: "The requested resource was not found.",
      },
      { status: 404 },
    );
  }
}

function withScriptNonce(html: string, nonce: string): string {
  return html.replaceAll("<script>", `<script nonce="${nonce}">`);
}

function withSecurityHeaders(
  response: Response,
  request: Request,
  nonce: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");

  const url = new URL(request.url);
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/" ||
    url.pathname === "/login"
  ) {
    headers.set("cache-control", "no-store");
  }

  if (url.protocol === "https:") {
    headers.set(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/favicon.svg" ||
    pathname === "/api/health"
  );
}

function sameOrigin(
  request: Request,
  url: URL,
  publicBaseUrl?: string,
): boolean {
  const origin = request.headers.get("origin");
  const expectedOrigin = publicBaseUrl
    ? new URL(publicBaseUrl).origin
    : url.origin;
  return origin === null || origin === expectedOrigin;
}

function isSecureDeployment(url: URL, publicBaseUrl?: string): boolean {
  return publicBaseUrl
    ? new URL(publicBaseUrl).protocol === "https:"
    : url.protocol === "https:";
}

async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function unauthorizedResponse(): Response {
  return Response.json(
    { code: "unauthorized", message: "Authentication required." },
    { status: 401 },
  );
}

export function resolveClientIp(request: Request): string | null {
  const cloudflareIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflareIp) return cloudflareIp;

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) return null;
  const entries = forwardedFor
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.at(-1) ?? null;
}

function syncAlreadyRunningResponse(): Response {
  return Response.json(
    {
      code: "sync_already_running",
      message: "A sync is already running.",
    },
    { status: 409 },
  );
}

function isSyncRateLimited(sessionToken: string): boolean {
  const now = Date.now();
  for (const [key, bucket] of syncRequestBuckets) {
    if (now - bucket.startedAt >= syncRateLimitWindowMs) {
      syncRequestBuckets.delete(key);
    }
  }

  const bucket = syncRequestBuckets.get(sessionToken);
  if (!bucket || now - bucket.startedAt >= syncRateLimitWindowMs) {
    syncRequestBuckets.set(sessionToken, { startedAt: now, count: 1 });
    return false;
  }
  if (bucket.count >= syncRateLimitMax) return true;
  bucket.count += 1;
  return false;
}

export const handleRequest = createRequestHandler();

function readQueryNumber(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
