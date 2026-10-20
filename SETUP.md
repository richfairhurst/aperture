# Aperture Setup

This guide covers local development for the Bun/SQLite v1 application. The
public product and data contracts are defined in [SPEC.md](SPEC.md).

## Prerequisites

- Bun `1.3.11` (see `.bun-version`)
- A Readwise Reader API token
- A TypeSafe Jev API key and model identifier
- A summary-provider credential if summaries are enabled
- SMTP credentials for magic-link authentication

Optional source adapters require their own credentials or local tools:

- YouTube Data API and `yt-dlp`
- Mediastack
- ROSTI

## Local installation

From the repository root:

```bash
cp .env.example .env
bun install
bun run check
```

The populated `.env` file is ignored. Never copy production credentials into
source control, test fixtures, browser JavaScript, or the SQLite database.

## Environment configuration

### Required for a normal authenticated run

```text
READWISE_API_TOKEN
TYPESAFE_API_KEY
AUTH_ACCESS_MODE
AUTH_APPROVED_EMAIL       # required when AUTH_ACCESS_MODE=allowlist
AUTH_BASE_URL
EMAIL_SERVER
EMAIL_PORT
EMAIL_USER
EMAIL_PASS
EMAIL_FROM
```

### Summary provider

Set `SUMMARY_API_KEY` or `OPENAI_API_KEY`, together with the configured model
and summary limits. Summary generation is optional during local development but
is required for a complete production feed card.

### Optional providers

```text
YOUTUBE_API_KEY
MEDIASTACK_API_KEY
ROSTI_API_KEY
```

Provider enablement, endpoints, cadence, limits, and non-secret defaults belong
in `config.toml`.

## Authentication modes

`AUTH_ACCESS_MODE=allowlist` restricts sign-in to `AUTH_APPROVED_EMAIL` and is
the recommended private mode.

`AUTH_ACCESS_MODE=public` permits any syntactically valid email to request a
single-use link and is intended only for an explicitly shared demo.

## Database and migrations

The default database is `data/aperture.sqlite`. It is created automatically on
startup. Ordered migrations in `migrations/` are applied automatically and must
remain in source control. Do not commit database files or provider content.

## Verification

Run the full check before opening a pull request:

```bash
bun run check
```

The check includes TypeScript validation, formatting, Vitest tests, and Bun
tests that exercise native SQLite and HTTP behaviour.

## Local smoke test

With the server running:

```bash
curl -fsS http://localhost:3000/api/health
```

Expected response:

```json
{ "service": "personal-intelligence-feed-local", "status": "ok" }
```

## Related documents

- [README.md](README.md) — project overview
- [SPEC.md](SPEC.md) — product and technical specification
- [DEPLOYMENT.md](DEPLOYMENT.md) — sanitized VPS deployment checklist
