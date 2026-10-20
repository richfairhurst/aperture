# Aperture

A private, single-user intelligence feed that turns recently added Readwise
Reader documents and selected public sources into a ranked, explainable reading
queue.

## Status

This repository contains the v1 Bun/SQLite implementation. It is a personal
project and public technical baseline, not a multi-user SaaS product.

## What it does

- Imports supported articles, RSS items, and text-capable newsletters from
  Readwise Reader.
- Collects optional Reddit, GitHub Trending, Mediastack, YouTube, Reports, and
  CVE sources.
- Normalises content and evaluates it with TypeSafe Jev.
- Ranks stories by quality, personal utility, and actionability.
- Generates structured summaries through a server-side model provider.
- Presents independent News, Reports, and CVE views with filtering and
  pagination.
- Uses passwordless magic-link authentication with public-demo or allowlist
  access modes.

## Architecture

```text
Readwise and public providers
              │
              ▼
      Bun application on VPS
              │
              ├── SQLite + ordered migrations
              ├── Jev evaluation and summaries
              ├── Authentication and HTTP API
              └── HTML/CSS/browser JavaScript frontend
              │
              ▼
      Cloudflare Tunnel or reverse proxy
```

The application is a long-running Bun process. SQLite is the default database,
and the `migrations/` directory is required for fresh databases and upgrades.
Production credentials remain server-side in environment configuration.

## Quick start

Requirements: [Bun](https://bun.sh/) `1.3.11` and a local SQLite-compatible
environment.

```bash
cp .env.example .env
# Fill in the provider and authentication values required for your setup.
bun install
bun run check
bun run start
```

The server defaults to `http://localhost:3000`. Startup creates `data/` and
applies any pending migrations automatically.

For a minimal health check:

```bash
curl http://localhost:3000/api/health
```

## Development commands

```bash
bun run start          # run the application
bun run test           # Vitest suite
bun run test:sqlite    # Bun/native SQLite suite
bun run typecheck      # TypeScript only
bun run format:check   # formatting verification
bun run check          # complete local verification
```

## Configuration

- `config.toml` contains non-secret application, provider, ranking, and cadence
  defaults.
- `.env.example` documents secret names and local defaults.
- `.env` is local-only and must never be committed.
- `data/aperture.sqlite` is local runtime data and is ignored by Git.

Provider credentials include Readwise, Jev, optional summary, email, and source
adapter credentials. See [SETUP.md](SETUP.md) for the configuration checklist.

## Repository layout

```text
src/             Bun server, providers, pipelines, repositories, and auth
public/          frontend HTML and static assets
tests/           unit, HTTP, provider, and SQLite tests
migrations/      ordered SQLite schema migrations
config.toml      non-secret runtime defaults
data/            ignored local SQLite database
SPEC.md          public product and technical specification
SETUP.md         local development checklist
DEPLOYMENT.md    sanitized VPS deployment guide
```

## Security

The application treats provider content and provider-supplied URLs as
untrusted. It validates outbound URLs, uses restrictive response headers,
protects state-changing requests with origin/CSRF checks, rate-limits sensitive
operations, and keeps credentials out of browser code and SQLite.

See [SECURITY.md](SECURITY.md) for vulnerability reporting. See [SPEC.md](SPEC.md)
for the complete threat model and security requirements.

## Documentation

- [SPEC.md](SPEC.md) — product behaviour and technical contracts
- [SETUP.md](SETUP.md) — local setup and configuration
- [DEPLOYMENT.md](DEPLOYMENT.md) — VPS and edge deployment guidance
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution and verification guidance
