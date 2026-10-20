import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Database } from "bun:sqlite";
import nodemailer from "nodemailer";

const magicLinkLifetimeMs = 15 * 60 * 1000;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const cleanupIntervalMs = 60 * 60 * 1000;
const cleanupRetentionMs = 7 * 24 * 60 * 60 * 1000;

export type AuthUser = { id: string; email: string };

export type AuthMailer = {
  sendMagicLink: (email: string, link: string) => Promise<void>;
};

export type AuthOptions = {
  approvedEmail: string;
  accessMode: "allowlist" | "public";
  baseUrl: string;
  mailer: AuthMailer;
  now?: () => Date;
  randomToken?: () => string;
};

type UserRow = { id: string; email: string };
type SessionRow = {
  id: string;
  user_id: string;
  email: string;
  csrf_token: string;
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createSecret(): string {
  return randomBytes(32).toString("base64url");
}

export class AuthService {
  private readonly now: () => Date;
  private readonly randomToken: () => string;
  private readonly approvedEmail: string;
  private readonly requestBuckets = new Map<
    string,
    { startedAt: number; count: number }
  >();
  private lastCleanupAt = 0;

  constructor(
    private readonly database: Database,
    private readonly options: AuthOptions,
  ) {
    this.approvedEmail = normalizeEmail(options.approvedEmail);
    if (
      options.accessMode === "allowlist" &&
      !this.approvedEmail.includes("@")
    ) {
      throw new Error("AUTH_APPROVED_EMAIL must be a valid email address");
    }
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? createSecret;
  }

  async requestMagicLink(
    email: string,
    requestIp: string | null,
  ): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    const now = this.now();
    this.cleanupExpiredData(now);
    const bucketKey = `${normalizedEmail}:${requestIp ?? "unknown"}`;
    const bucket = this.requestBuckets.get(bucketKey);
    if (bucket && now.getTime() - bucket.startedAt < magicLinkLifetimeMs) {
      if (bucket.count >= 5) return;
      bucket.count += 1;
    } else {
      this.requestBuckets.set(bucketKey, {
        startedAt: now.getTime(),
        count: 1,
      });
    }
    if (!isValidEmail(normalizedEmail)) return;
    if (
      this.options.accessMode === "allowlist" &&
      normalizedEmail !== this.approvedEmail
    ) {
      return;
    }

    const rawToken = this.randomToken();
    this.database
      .query(
        `INSERT INTO magic_link_tokens
          (id, email, token_hash, created_at, expires_at, request_ip)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        normalizedEmail,
        hashSecret(rawToken),
        now.toISOString(),
        new Date(now.getTime() + magicLinkLifetimeMs).toISOString(),
        requestIp,
      );

    const link = new URL("/api/auth/magic-link/verify", this.options.baseUrl);
    link.searchParams.set("token", rawToken);
    await this.options.mailer.sendMagicLink(normalizedEmail, link.toString());
  }

  consumeMagicLink(rawToken: string): {
    sessionToken: string;
    csrfToken: string;
    user: AuthUser;
  } | null {
    const now = this.now();
    const tokenHash = hashSecret(rawToken);
    const token = this.database
      .query<{ id: string; email: string; expires_at: string }, [string]>(
        `SELECT id, email, expires_at FROM magic_link_tokens
         WHERE token_hash = ? AND consumed_at IS NULL`,
      )
      .get(tokenHash);
    if (!token || Date.parse(token.expires_at) <= now.getTime()) return null;

    const user = this.findOrCreateUser(token.email, now);
    const sessionToken = this.randomToken();
    const csrfToken = this.randomToken();
    this.database.transaction(() => {
      const consumed = this.database
        .query(
          `UPDATE magic_link_tokens SET consumed_at = ?
           WHERE id = ? AND consumed_at IS NULL`,
        )
        .run(now.toISOString(), token.id);
      if (consumed.changes !== 1)
        throw new Error("magic_link_already_consumed");
      this.database
        .query(
          `INSERT INTO auth_sessions
            (id, user_id, session_hash, csrf_token, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          user.id,
          hashSecret(sessionToken),
          hashSecret(csrfToken),
          now.toISOString(),
          new Date(now.getTime() + sessionLifetimeMs).toISOString(),
        );
    })();

    return { sessionToken, csrfToken, user };
  }

  getSession(
    sessionToken: string | null,
  ): { user: AuthUser; csrfToken: string } | null {
    if (!sessionToken) return null;
    const now = this.now();
    this.cleanupExpiredData(now);
    const row = this.database
      .query<SessionRow, [string, string]>(
        `SELECT s.id, s.user_id, u.email, s.csrf_token
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.session_hash = ? AND s.revoked_at IS NULL
           AND s.expires_at > ?`,
      )
      .get(hashSecret(sessionToken), now.toISOString());
    if (!row) return null;
    return {
      user: { id: row.user_id, email: row.email },
      csrfToken: row.csrf_token,
    };
  }

  revokeSession(sessionToken: string | null): void {
    if (!sessionToken) return;
    this.database
      .query(`UPDATE auth_sessions SET revoked_at = ? WHERE session_hash = ?`)
      .run(this.now().toISOString(), hashSecret(sessionToken));
  }

  validateCsrf(
    session: { csrfToken: string },
    suppliedToken: string | null,
  ): boolean {
    if (suppliedToken === null) return false;
    const suppliedHash = Buffer.from(hashSecret(suppliedToken), "hex");
    const expectedHash = Buffer.from(session.csrfToken, "hex");
    return (
      suppliedHash.length === expectedHash.length &&
      timingSafeEqual(suppliedHash, expectedHash)
    );
  }

  cleanupExpiredData(now = this.now()): void {
    if (now.getTime() - this.lastCleanupAt < cleanupIntervalMs) return;
    const cutoff = new Date(now.getTime() - cleanupRetentionMs).toISOString();
    this.database
      .query(
        `DELETE FROM magic_link_tokens
         WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at <= ?)`,
      )
      .run(now.toISOString(), cutoff);
    this.database
      .query(
        `DELETE FROM auth_sessions
         WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
      )
      .run(now.toISOString(), cutoff);
    for (const [key, bucket] of this.requestBuckets) {
      if (now.getTime() - bucket.startedAt >= magicLinkLifetimeMs) {
        this.requestBuckets.delete(key);
      }
    }
    this.lastCleanupAt = now.getTime();
  }

  private findOrCreateUser(email: string, now: Date): UserRow {
    const existing = this.database
      .query<UserRow, [string]>(`SELECT id, email FROM users WHERE email = ?`)
      .get(email);
    if (existing) {
      this.database
        .query(`UPDATE users SET last_login_at = ? WHERE id = ?`)
        .run(now.toISOString(), existing.id);
      return existing;
    }
    const user = { id: randomUUID(), email };
    this.database
      .query(
        `INSERT INTO users (id, email, created_at, last_login_at) VALUES (?, ?, ?, ?)`,
      )
      .run(user.id, user.email, now.toISOString(), now.toISOString());
    return user;
  }
}

export function createSmtpMailerFromEnv(): AuthMailer {
  const host = process.env.EMAIL_SERVER;
  const port = Number(process.env.EMAIL_PORT ?? 587);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const from = process.env.EMAIL_FROM ?? user;
  if (!host || !user || !pass || !from || !Number.isInteger(port)) {
    throw new Error(
      "EMAIL_SERVER, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, and EMAIL_FROM are required",
    );
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
  });
  return {
    async sendMagicLink(email, link) {
      await transporter.sendMail({
        from,
        to: email,
        subject: "Your Aperture sign-in link",
        text: `Sign in to Aperture using this link:\n\n${link}\n\nThis link expires in 15 minutes and can only be used once.`,
      });
    },
  };
}

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const cookie of cookies.split(";")) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `aperture_session=${encodeURIComponent(token)}; Path=/; Max-Age=${sessionLifetimeMs / 1000}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function csrfCookie(token: string, secure: boolean): string {
  return `aperture_csrf=${encodeURIComponent(token)}; Path=/; Max-Age=${sessionLifetimeMs / 1000}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export const clearedSessionCookie =
  "aperture_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";

export const clearedCsrfCookie =
  "aperture_csrf=; Path=/; Max-Age=0; SameSite=Lax";
