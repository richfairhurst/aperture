# Aperture — Personal Intelligence Feed

|                  |                            |
| ---------------- | -------------------------- |
| **Spec version** | 2.0 — consolidated         |
| **Date**         | 2026-10-20                 |
| **Status**       | v1 implementation baseline |
| **Owner**        | Rich Fairhurst             |

## Contents

1. [Purpose](#1-purpose)
2. [Goals](#2-goals)
3. [Non-goals](#3-non-goals)
4. [Product Decisions](#4-product-decisions)
5. [User Experience](#5-user-experience)
6. [External Integrations](#6-external-integrations)
7. [Jev Rubric](#7-jev-rubric)
8. [Ranking](#8-ranking)
9. [Processing Pipeline](#9-processing-pipeline)
10. [Data Model](#10-data-model)
11. [Failure Handling](#11-failure-handling)
12. [Security and Privacy](#12-security-and-privacy)
13. [Observability](#13-observability)
14. [Testing and Evaluation](#14-testing-and-evaluation)
15. [Acceptance Criteria](#15-acceptance-criteria)
16. [Implementation Defaults](#16-implementation-defaults)
17. [Validation and Operations Checklist](#17-validation-and-operations-checklist)
18. [Glossary](#18-glossary)
19. [Reference Documentation](#19-reference-documentation)

Appendix A records the decisions made while consolidating earlier drafts of
this specification into its current form.

### How to read this document

The key words **must**, **must not**, **should**, and **may** are used in the
RFC 2119 sense. A **must** is a hard requirement; a violation is a defect. A
**should** is a strong default that may be set aside only with a recorded
reason. A **may** is an explicitly permitted option.

Each rule is stated exactly once, in the section that owns it. Other sections
cross-reference rather than restate.

## 1. Purpose

Build an intelligence feed that retrieves and evaluates News, Reports, and CVE
items, creates short summaries where appropriate, and presents independent
ranked collections in a simple web application. The initial deployment is a
shared public demo; personalisation and private multi-user accounts remain
future work.

The system is intended to reduce reading triage time for content related to:

- Artificial intelligence
- Cybersecurity and cyber risk
- Executive decision-making
- Technology strategy
- Relevant commercial opportunities
- National security, geopolitics, defence, and intelligence

The first release is a personal tool, not a multi-user SaaS product.

## 2. Goals

- Provide a useful daily queue from the user's Readwise library.
- Separate content quality from personal usefulness.
- Make labels, scores, probabilities, and rubric versions inspectable.
- Keep the scoring rubric configurable without changing application code.
- Process each document idempotently and recover from transient failures.
- Keep all external credentials server-side.
- Establish a measurable baseline for Jev's usefulness before expanding scope.
- Reduce duplicate coverage of the same underlying story before expensive model processing.
- Distinguish new developments from new reporting about older events.
- Make every surfaced item explainable through evidence, provenance, and an explicit triage state.
- Support a configurable intelligence profile and editorial brief that govern
  collection and presentation; editing UI is an optional extension.

### 2.1 Success measures

The baseline build's stated purpose — establish whether this feed meaningfully
improves reading triage — is measured as follows. The measures are recorded
during a two-week daily-use window after launch and reviewed at the decision
gate:

- **Triage outcome:** for each item surfaced as `read_now` or
  `important_context`, record whether the user opened the source. A useful feed
  has a high open ratio for surfaced items and few opened items that were never
  surfaced.
- **Triage time:** record approximate time spent scanning the feed per day
  versus the user's pre-tool baseline for triaging the same volume in Readwise.
- **Jev agreement:** the labelled evaluation set (§14) records agreement and
  disagreement rates for topic labels and quality/utility scores by rubric and
  model version.
- **Cost and latency:** estimated processing cost per document and per sync,
  and end-to-end latency from document ingestion to feed publication, recorded
  per sync (§13).

These measures are recorded observations, not automated gates. The written
proceed/defer decision (§14) uses them.

## 3. Non-goals

- General-purpose web crawling or a wholesale replacement for established
  intelligence products.
- Multiple user accounts with roles, billing, teams, per-user settings, or
  account-management workflows. The public demo permits access through a
  one-time email link but does not yet provide a full account product.
- Automatic model training from user feedback.
- Processing video, audio, EPUB, or image-only documents (the optional YouTube
  adapter processes transcripts as text; see §6.2).
- Writing labels, summaries, or other enrichments back to Readwise.
- Using OpenCode as a production background-process runtime.
- Generating a definitive or objective measure of article quality.

## 4. Product Decisions

- **Audience:** shared public demonstration, with optional private allowlist mode.
- **Ingestion window:** documents added to the source, based on the source's
  `created_at`, not the article's `published_date` or `saved_at`.
- **Primary News source:** Readwise Reader API, surfaced under the feed
  identity `rss`.
- **Initial document types:** articles, RSS items, and newsletters represented
  as text-capable Reader documents.
- **Classification and scoring:** TypeSafe Jev API.
- **Prose generation:** direct model API, configured independently of OpenCode.
- **Storage:** SQLite for the default deployment; the repository boundary must keep
  a future managed relational database migration possible.
- **Hosting:** a long-running Bun/TypeScript application on a Linux VPS, fronted by
  a reverse proxy or outbound tunnel when public access is required.
- **Ranking:** quality and personal utility are the primary axes, with
  actionability as a third weighted component combined in code (§8).
- **Feedback:** no learning loop in the baseline build; rubric configuration
  remains editable.
- **Enrichment storage:** application database only.
- **Feed retention:** all News content — including items in the `archive`
  triage state — is deleted three days after publication or creation (§9.3).
  Reports have a separate retained provenance/version store, but the active
  Reports view is an observation window rather than a permanent library.
- **Home feed default:** the News feed returns `published` items within the
  retention window whose final score meets the configurable minimum display
  score (default 80), sorted by final score descending with recency as the
  tie-break (§8). Additional results load through stable cursor pagination.
- **Evaluation passes:** the baseline uses one full evaluation pass followed by
  validated summarisation. An optional coarse pass may reduce model cost before
  full evaluation.
- **Story clustering** is an optional extension. When enabled, multiple
  documents about one event produce one feed story with related source
  coverage. The baseline is document-first and must not depend on clustering
  (§9, §10).
- **Mechanical processing and personal judgement are separate.** Mechanical
  signals may order work but must not silently determine what is important to
  the user.
- **News ingestion remains Readwise-first.** Ingestion and normalisation
  interfaces must support additional News source adapters later without
  requiring a feed-schema redesign.
- **Reports are a separate collection** with separate identity, provenance,
  evaluation, ranking, summary, filtering, and active-window semantics. News
  and Reports must not be mixed by overloading a News category or content type.
- **This is a personal intelligence feed, not a PR/newsjacking tool.** It does
  not generate pitches, journalist lists, media lists, or outreach.

### 4.1 Delivery principles

Deliver the system in vertical stages. Each stage must prove its user and
system behaviour before additional complexity is added. The baseline build
uses one full Jev evaluation pass, document-level persistence, bounded
processing, and the independent News, Reports, and CVE collection contracts
defined below. Story clustering, corroboration, coarse evaluation, profile
learning, and distributed job queues are optional extensions rather than
hidden baseline dependencies.

### 4.2 Operational defaults

Numbers stated here are deployment defaults; all remain configurable.

| Area                              | Default                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| News ingestion window             | 12 hours                                                          |
| News retention                    | 3 days, cascade purge (§9.3)                                      |
| Reports discovery cadence         | hourly                                                            |
| Reports provider query window     | 48 hours                                                          |
| Reports active observation window | 72 hours                                                          |
| Reports UI time filters           | 1h / 4h / 1d / 3d (observation time)                              |
| CVE polling                       | every 6 hours                                                     |
| CVE ingestion window              | 24 hours                                                          |
| CVE retention                     | 7 days                                                            |
| GitHub Trending cadence           | every 6 hours; max 25 repositories and 25 README fetches per poll |
| Reddit cadence                    | hourly                                                            |
| Mediastack cadence                | daily                                                             |
| Summary generation                | max 20 per sync, concurrency 3, 2 retries with backoff            |
| Pipeline job retries              | 3 attempts with bounded exponential backoff (§9.2)                |
| Document truncation               | 40,000 normalised characters, paragraph boundary                  |
| Recovery maximum age              | 30 days                                                           |
| Readwise list rate limit          | 20 requests/minute/token                                          |

Additional operational defaults:

- Use SQLite migrations for documents, versions, evaluations, summaries, feed
  items, Reports, CVEs, authentication, and diagnostics.
- Run a supervised hourly scheduler with independent source cadence guards.
  Cadence guards are scheduling policy, not content eligibility.
- Use Readwise Reader as the `rss` News source identity. Readwise remains the
  upstream provider implementation; persisted feed filters use
  `source_name=rss`.
- A News feed query returns only `publication_status=published`; evaluated
  items remain persisted as `summary_pending` until their summary completes
  (§9.3). This prevents incomplete cards from appearing in the UI.
- The scheduler and provider calls are best-effort while the application
  process is running. Use process supervision, persistent logs, and backups;
  durable distributed job queues are optional extensions.

### 4.3 Deployment profile

The hosted demo uses a Linux VPS with Bun, SQLite, systemd-compatible process
supervision, and an outbound tunnel or reverse proxy. The application listens
on a loopback service port; the edge access layer exposes the public HTTPS
hostname without requiring an inbound application port. Firewall policy must
default to deny inbound traffic, and SSH administration should use the private
management network where available.

The default demonstration deployment uses `AUTH_ACCESS_MODE=public`: any
syntactically valid email may request a single-use magic link. Successful
authentication creates or retrieves an application user record, but all users
see the same shared feed and there are no user-specific settings or permissions
yet. A private deployment may use `AUTH_ACCESS_MODE=allowlist` with
`AUTH_APPROVED_EMAIL` instead.

## 5. User Experience

### 5.1 Interface composition

The primary screen is a daily ranked queue. Each item displays:

- Title
- Source/site and author when available
- Date added to Readwise
- Original source link
- Content type
- Quality score
- Personal utility score
- Final ranking score
- Jev-selected topic and content-type labels
- Short summary
- Why it matters
- Key points
- Recommended action, when applicable
- Triage state (§5.2)
- Freshness status and confidence
- Evidence status and source provenance

The user can:

- Filter by label.
- Filter by minimum quality or utility score.
- Sort by final score (default) or newest (§8).
- Open the original source.
- Expand full scoring details, including rubric version and confidence.
- View automatic collection status and progress. Manual triggering, if needed,
  is an administrative/API capability rather than a primary UI action.
- View processing failures and retry an item.
- Browse older items within the retention window using cursor pagination.
- Filter or group by triage state.
- See why an item was surfaced, including personal relevance, freshness,
  evidence status, and source provenance.
- When clustering is enabled, expand a story cluster to see the primary source,
  related coverage, duplicate count, and disagreements between sources.
- Review and confirm proposed changes to the intelligence profile or editorial
  brief based on explicit feedback (optional extension).

The baseline build does not require likes, dislikes, saved states, comments, or
personalised learning.

### 5.2 Triage states

Triage states carry the following meanings. They are **definitions, not the
default sort order** — the default feed ordering is final score descending
(§8). Triage state is a filter and grouping control, and the default view
excludes `archive` items unless explicitly requested.

1. `read_now` — high personal utility, credible evidence, and immediate
   decision or action relevance.
2. `important_context` — materially important stories that need awareness but
   do not have an immediate personal action.
3. `watch` — relevant or potentially useful items with weak evidence, uncertain
   freshness, low urgency, or insufficient personal fit.
4. `archive` — low-signal, promotional, duplicate, or out-of-scope items.
   They are retained until routine News retention removes them (§9.3) and are
   excluded from the default queue.

Every `read_now` and `important_context` item must answer: what happened, why
it is in the feed, why it matters to the user, what evidence supports it, and
what action or decision follows, if any.

### 5.3 User journey

#### First use

The first-use flow must avoid presenting a large configuration form or asking
for optional credentials before the user sees value.

1. Explain that the product turns the user's reading queue into a ranked,
   evidence-aware intelligence feed.
2. Load the configured intelligence profile for AI, cybersecurity, executive
   decision-making, technology strategy, and commercial opportunity.
3. Start or open the application and allow the automatic initial collection run
   to complete, showing processing status.
4. Present the first ranked News feed with visible reasons and source evidence.

When settings editing is enabled, the user may amend the profile with topics,
named entities, current decisions, preferred source types, exclusions, and an
editorial brief.

Optional source integrations must be offered only after the Readwise path has
produced a first result. A missing optional source is reduced coverage, not a
failed sync.

#### Daily use

The default view is the ranked queue of §5.1. The user triages top-down:
`read_now` first by score, then `important_context`, then `watch` as time
allows. The user may group or filter by triage state (§5.2).

#### Feedback

The user may give explicit feedback such as "too many policy stories", "show
more practical AI implementation", or "this was useful". The system must not
silently train or alter scores. Instead it may propose a dated change to the
intelligence profile or editorial brief. The user must confirm before the
change becomes active. Feedback proposals and confirmations are auditable.

### 5.4 Functional design brief

The interface should use a dense, scan-friendly ranked-feed information
architecture with visible scores, labels, filters, and source links.

Design for fast triage rather than prolonged browsing:

- Use a clear page header showing the feed date, last automatic sync time, and
  collection status.
- Use a filter toolbar that remains easy to reach on desktop and mobile.
- Present each document as a compact but readable feed card or row.
- Make the final score visually prominent without hiding quality and utility
  component scores.
- Show labels as compact, accessible controls that can also act as filters.
- Keep summaries collapsed to a useful scan length, with details expandable.
- Make the original source link obvious and open it in a new tab.
- Use responsive layouts: wide rows on desktop and single-column cards on mobile.
- Provide loading, empty, partial-processing, error, and retry states.
- Use colour as a secondary signal; scores and status must remain legible
  without colour perception.
- Show the triage state as a text label, not only colour.
- Show freshness status and evidence confidence on every non-archived item.
- When clustering is enabled, treat a story cluster as the primary feed unit
  when multiple documents cover the same event; do not render every duplicate
  as a separate top-level card.

Content-rendering rules:

- Do not render untrusted article HTML; render plain text through safe DOM
  text nodes (§12).
- The baseline does not render remote article images. `image_url` is retained
  as metadata only. This keeps the Content Security Policy restrictive (§12).
- Source and format labels (`source_name`, `category`) are distinct from Jev's
  `content_type`; the UI must not overload one with the other.

The filterable News labels in the baseline build are `primary_topic`,
`content_type`, source/category, and triage state. Reports have an independent
filter model (§5.5).

The implementation may choose the exact visual system, component library, and
typography while preserving this hierarchy and behaviour.

### 5.5 Collections and routes

The primary UI provides three top-level tabs:

- **News**: the ranked Readwise/news queue, with News-specific filters, sorting,
  pagination, loading/error states, and URL state.
- **Reports**: newly observed or updated intelligence reports, with independent
  filters, sorting, pagination, loading/error states, and URL state.
- **CVEs**: recently observed CIRCL vulnerabilities, with independent severity,
  CVSS, search, time-window, sorting, pagination, and expandable-detail state.

Switching tabs must not leak controls or state between collections. News
sorting options must not appear in the Reports toolbar, and Reports sorting
options must not appear in the News toolbar.

#### Reports

The Reports API and UI support:

- source (`orkl`, `rosti`, or curated annual-report repository);
- report type (`threat_intelligence`, `annual_analysis`, `survey`, `research`,
  or `other`);
- primary topic;
- temporal classification;
- report year;
- minimum final score;
- score/recent sorting; and
- stable cursor pagination.

Reports also expose observation-time filters for `1h`, `4h`, `1d`, and `3d`.
These filters use the time the report was observed by the application, not the
source publication date. The default active window is 72 hours from observation
or source update. Reports outside that window may remain in the
provenance/version store for deduplication and re-evaluation, but must not
appear in the default active collection.

The UI must distinguish **new report**, **new reporting on historical
activity**, **updated edition**, and **annual/recurring publication**. A new
API record or GitHub commit must not be treated as evidence that the underlying
threat activity is new (§6.3).

#### CVEs

The CVE API and UI are independent from News and Reports. The baseline uses
CIRCL only and displays normalised CVE ID, title, severity, CVSS score/vector,
published/modified timestamps, affected products, mitigation, and references.
It must not invoke Jev, ranking, summary generation, CISA KEV, or NVD
enrichment unless a future specification explicitly adds those capabilities.

#### Required routes

- `GET /` — ranked feed and filters; unauthenticated requests redirect to `/login`.
- `GET /login` — public magic-link login page.
- `GET /api/health` — liveness and database health; public; no secrets.
- `POST /api/sync` — manual sync trigger; authenticated; returns a run
  identifier immediately. Not a primary UI action (§5.1).
- `GET /api/runs` — recent sync runs with aggregate counts; authenticated.
- `GET /api/runs/:id` — progress, status, counts, and safe errors for one run;
  authenticated.
- `POST /api/errors/:id/retry` — retry one failed item through the relevant
  pipeline stages; authenticated; idempotent (§9.2).
- `GET /api/feed` — published News feed with source/category/topic/type/triage/
  time filters, score thresholds, sorting, and cursor pagination.
- `GET /api/reports` — independent Reports feed with provider, type, topic,
  temporal, year, score, observation-window, sorting, and cursor filters.
- `GET /api/vulnerabilities` — independent CIRCL CVE feed with severity, CVSS,
  search, time-window, sorting, and cursor filters.
- `GET /api/diagnostics` — source health, collection run, and processing
  status; authenticated.
- `GET /settings` — optional extension for non-secret profile, editorial brief,
  rubric, ranking, ingestion, source, and account settings.
- `GET /admin/runs` — optional extension for sync history, processing failures,
  and retry controls; `/api/diagnostics` is required regardless.

Authentication routes are listed in §5.7. Exact handler names and module
structure are implementation details; the routes above are not.

When enabled, settings changes are authenticated, rate-limited, validated, and
versioned. The settings screen provides controlled forms rather than arbitrary
JSON editing.

### 5.6 API behaviour

The application must provide authenticated capabilities for feed retrieval,
manual sync, diagnostics/run inspection, and item retry where supported.
Settings editing, explicit reprocessing, and per-document content purge are
optional extensions.

Feed responses must support filtering by topic/type label, minimum component
score, triage state, freshness status, evidence status, date window, and sort
order. Feed results use cursor pagination and must return a stable cursor for
the selected ordering. The default query returns only the latest successfully
processed version of each document within the retention window, meeting the
minimum display score. When clustering is enabled, the query groups documents
by story cluster.

The baseline feed is document-first. When clustering is enabled, a story
cluster is rendered once with its primary document and related source
observations nested beneath it. Without clustering, each eligible document is
rendered as an independent feed item and is not treated as corroborated.

The API must expose, for each feed item:

- A stable feed-item identifier and its source document.
- Story-cluster and related-coverage fields when clustering is enabled.
- Source identity, canonical URL, and provenance.
- `freshness_status`, `freshness_confidence`, and the relevant timestamps.
- `evidence_status` and source provenance.
- `triage_state` and `triage_reason`.
- `publication_status`, including persisted `summary_pending` where applicable
  (§9.3).
- The active profile, brief, rubric, prompt, and model versions used.

When settings editing is enabled, the API must provide authenticated endpoints
to retrieve and edit the active intelligence profile and brief. Feedback
proposals and confirm/reject workflows are optional extensions. Confirmed
changes create a new version and do not alter historical evaluations.

All API errors return a safe user-facing code and message without credentials,
raw provider secrets, or full article contents. Operational actions return a
run or job identifier so progress can be inspected asynchronously.

### 5.7 Authentication and hosted access

The application must expose a public login page and require authentication for
the News, Reports, CVE, diagnostics, sync, retry, run-inspection, and settings
routes. Health checks, static assets, and authentication initiation/callback
routes remain public.

The baseline build authentication flow is passwordless email magic links:

1. The user submits an email address through `POST /api/auth/magic-link`.
2. The server normalises and validates the address, applies the configured
   access mode, and returns a generic response that does not reveal whether an
   address is permitted.
3. A permitted address receives a cryptographically random, single-use link
   that expires after 15 minutes. Only a hash of the token is stored.
4. The verification callback consumes the token atomically, creates or finds a
   minimal application user, rotates the session, and redirects to the public
   base URL.
5. Logout revokes the server-side session and clears the browser cookies.

Supported access modes are explicit:

- `public`: any syntactically valid email may request a link. This is the
  shared demo mode; users share the same feed and have no private settings or
  roles.
- `allowlist`: only `AUTH_APPROVED_EMAIL` may authenticate. This is the private
  deployment mode.

Required authentication routes:

- `GET /login`
- `POST /api/auth/magic-link`
- `GET /api/auth/magic-link/verify`
- `GET /api/auth/session`
- `POST /api/auth/logout`

Sessions are server-side and use Secure, HttpOnly, SameSite cookies when the
public base URL is HTTPS. State-changing requests require CSRF/origin checks
that account for reverse proxies and tunnels. Login requests are rate-limited
by normalised email and client address. Google OAuth is not part of the current
baseline implementation.

## 6. External Integrations

### 6.1 Readwise Reader API (`rss`)

Use the Reader API document list endpoint:

`GET https://readwise.io/api/v3/list/`

Authentication uses the server-side `Authorization: Token <token>` header.

Required behaviour:

- Query using a stored synchronisation watermark with `updatedAfter`.
- Follow `nextPageCursor` until all relevant pages are consumed.
- Request `withHtmlContent=true` for supported documents.
- Filter to documents whose `created_at` falls within the configured ingestion
  window.
- Filter unsupported categories (`article`, `rss`, `email` are supported)
  before expensive processing.
- Treat the Readwise document ID as the stable external identifier.
- Respect the documented list rate limit of 20 requests per minute per token.
- Retry 429 responses using `Retry-After`.

Watermark algorithm — the sync must be at-least-once and safe under failure:

- Store the watermark as a UTC timestamp and treat `updatedAfter` as an
  exclusive boundary. A sync must hold a single-sync lock (§10.5) so scheduled
  and manual syncs cannot race.
- At sync start, capture `watermark_before` and use it for every paginated
  request. Persist each page idempotently, but do not advance the global
  watermark until every page has been fetched and persisted successfully.
- Set `watermark_after` to the greatest observed Readwise `updated_at` value,
  with a configured overlap window on the next sync. The overlap prevents
  documents updated during a sync, or timestamp ties at the exclusive boundary,
  from being missed; database uniqueness and content hashes make repeated
  retrieval safe.
- If a page fails, retain the prior watermark, mark the sync failed or partial,
  and allow recovery to retry from `watermark_before`. A persisted page must
  never cause the global watermark to skip an unpersisted page.
- A normal sync considers documents created in the previous configured window
  (12 hours by default). Recovery may import documents created since the stored
  watermark, subject to a configurable maximum age of 30 days. Documents older
  than the recovery maximum are not imported automatically and require an
  explicit future backfill operation.

The implementation must not assume that `updatedAfter` alone means "added in
the last 12 hours"; it can include older documents that were edited.
Application-side `created_at` filtering is required.

### 6.2 Optional News sources

Reddit, GitHub Trending, Mediastack, and YouTube are optional News adapters.
All emit normalised observations through the common adapter contract (§6.4)
and receive no provider-specific ranking, prompts, or feed behaviour.

**Reddit** (`reddit`):

- Source: subreddit Atom/RSS feeds, configured through
  `sources.reddit.subreddits` (data-driven, no hard-coded list).
- Two-stage contract: parse the subreddit feed as discovery metadata, then
  retrieve the linked external article as the content source. Reddit permalink
  and comments URLs must not be mistaken for the article URL. Substantive
  self-post text may be used as fallback when no external link exists; empty or
  non-substantive entries are skipped with diagnostics.
- Stable identity: the Reddit entry ID. The linked article URL is the primary
  content/source URL so canonical-URL deduplication remains meaningful across
  sources.

**GitHub Trending** (`github_trending`):

- Two-stage contract: parse the daily Trending page for repository identity and
  metadata, then retrieve a substantive README from the public repository.
- "Daily discovery" means the parsed list is the daily Trending page observed
  at poll time; the six-hour polling cadence re-observes that page, and content
  hashing makes repeated polls of unchanged repositories idempotent.
- Substantive README content is the evaluation and summary authority. Projects
  without substantive README content are skipped rather than evaluated from a
  title/description stub.
- Stable identity is `owner/repository`; changed README content creates a new
  document version.
- Trending rank and repository metadata are provenance, not ranking weights.
- Use a descriptive User-Agent, respect unauthenticated rate limits, bound
  response size and duration, permit only expected public GitHub URLs, and
  isolate individual repository failures.

**Mediastack** (`mediastack`):

- Optional keyword-based News source, daily cadence, configured keywords
  queried sequentially with a bounded inter-request delay.
- Provider plan allowances (e.g. a monthly query allowance) are diagnostic
  references only; the application makes usage visible but must not silently
  enforce a quota as an ingestion stop.
- Stable identity derives from canonical URL plus publication date.

**YouTube** (`youtube`):

- Optional channel-discovery adapter: watch new videos on configured channels
  and ingest the transcript as the content document. The video URL is the
  canonical source link; captions/transcript availability gaps are a documented
  content-unavailable reason (§6.4), never a silent skip.

### 6.3 Reports discovery sources

Reports are discovered independently from News:

- **ORKL** provides public threat-intelligence library entries. Preserve the
  provider ID, canonical report/archive URL, publication/update metadata, and
  available text/PDF references.
- **ROSTI v2** provides authenticated report metadata using the server-side
  `X-Api-Key` header. Use timestamp/cursor pagination and fetch source-page
  content only for new or changed provider IDs. Detail retrieval uses bounded
  concurrency rather than an unbounded sequential loop.
- **GitHub annual reports** uses the configured curated repository and only
  treats new PDFs under `Annual Security Reports/<year>/` as candidates.
  README, index, workflow, metadata, image, and Markdown-only changes are
  ignored. A Markdown conversion may be paired with a new report asset, but a
  conversion-only change is not a new candidate.

For GitHub candidates, prefer a matching Markdown conversion for extraction but
retain the PDF as the authoritative source URL and provenance. If Markdown is
absent, extract the PDF directly. Provider failures must be isolated and
persisted as discovery diagnostics rather than failing other collections.

Report provenance must retain, where available: `source_published_at`,
`activity_start_at`, `activity_end_at`, `observed_at`, `updated_at`, report
year, report type, provider ID, canonical URL, and content hash. A zero or
sentinel provider date is treated as unknown, not as a real publication date.

Provider-supplied report type is authoritative when valid. When absent, the
implementation may infer `research`, `survey`, `annual_analysis`, or
`threat_intelligence` from explicit title/metadata signals; otherwise it must
use `other`. Inferred classifications must remain inspectable and reviewable.

**Report evaluation and summary contracts are versioned independently from
News**: `report-prompt-v1`, `report-rubric-v1`, `report-ranking-v1`, and
`report-summary-v1`. The concrete rubric and ranking are defined in §7.6;
they must not silently reuse News weights.

Report discovery must be failure-safe. Every provider, detail, PDF, and content
fetch has a bounded timeout; the complete discovery/processing run has a
maximum duration; and one provider failure must not prevent other providers
from being attempted. A persisted `running` run older than the stale-run
threshold must be marked failed and recovered on startup or the next scheduler
tick, so a process restart cannot permanently block future polling.

Report diagnostics must expose the latest run status, age, candidates found,
failures, active source, and active stage. The UI must distinguish a
successful empty discovery from a failed or currently running discovery.

Defaults: 30-second provider-request timeout, 10-minute run budget, stale-run
recovery after twice that budget, four concurrent processing workers.
Deployment-specific values remain configurable.

### 6.4 Source adapter contract

Readwise (`rss`) is the required News source for the baseline build. Reddit,
GitHub Trending, Mediastack, and YouTube are optional News adapters. ORKL,
ROSTI, and the curated annual-report repository are Reports sources. CIRCL is
an independent CVE adapter. All News adapters must implement the same internal
contract rather than writing source-specific records into the feed tables;
Reports and CVEs retain separate collection contracts and persistence.

Each adapter must return normalised `source_observation` records containing:

- `source_name` and `source_item_id`
- title, author, site, canonical URL, and content type
- source publication timestamp and source update timestamp, when available
- retrieved timestamp
- normalised plain-text content or a documented content-unavailable reason
- source-specific metadata retained as validated JSON
- an explicit provenance level: `primary`, `secondary`, `aggregator`, or
  `unknown`

Adapters must be independently rate-limited, retry 429 responses using the
provider's retry guidance, classify authentication/permanent/transient
failures, and report source health without failing the entire sync. The
absence of an optional source must be visible in run diagnostics and must not
prevent other sources from processing.

The adapter layer must not make source-specific assumptions about freshness,
importance, or personal utility. Those decisions belong to the common pipeline.

### 6.5 TypeSafe Jev API

Use:

`POST https://api.typesafe.ai/v1/systemone`

Authentication uses a server-side bearer token. The model must be
configurable through environment variables, with `jev-latest` as the default.

Send one document state containing normalised title, author, source,
metadata, article text, and the intelligence context needed for personal
scoring (active profile summary and editorial brief). Use independent typed
questions rather than one compound question. The request must include the
meaning of each rubric level (§7.2).

The application must persist the complete Jev response needed for audit and
re-ranking, including: model version, answers, probabilities, confidence
values, input token usage, rubric version, and request timestamp.

The application must validate the Jev response against the configured question
schema before storing typed result fields. The schema must identify the
question, answer, and type-specific result fields for each result:

- Choice results validate against the configured taxonomy, with probability
  distributions that contain exactly the configured keys and sum to
  approximately 1, and confidence in 0–1.
- Score results validate as finite numeric values within 0–4 (fractional
  values are accepted and preserved), with confidence in 0–1.
- Noul results validate their numeric value and may omit probability and
  confidence, because those fields are not guaranteed by the provider.
- Missing and unexpected questions are rejected.

Invalid provider output raises a typed validation error and becomes a failed
stage (§11), never a silently degraded result. Jev output is a decision aid,
not a guarantee of correctness.

### 6.6 Summary model API

Use a direct model API from the background worker. Do not invoke an interactive
OpenCode session for production processing.

The provider and model must be configurable through environment variables. The
provider and model remain provider-agnostic until deployment credentials and
capabilities are confirmed. The selected provider and model identifier must be
recorded for every generated summary. If OpenCode Zen is used as the LLM
gateway, the worker must call its supported API directly; the OpenCode
interactive client is not a production dependency.

**News summary contract** — strict structured JSON, validated by the
application. Required fields:

- `summary`: 1–2 concise sentences (under 60 words)
- `why_it_matters`: one concise sentence (under 35 words) tied to the user's
  focus; never empty — if relevance is limited, state its value as context
- `key_points`: exactly 3 concise points (each under 20 words)
- `recommended_action`: nullable short action (under 35 words)

The summary prompt must instruct the model not to invent facts, distinguish
claims from evidence, and state when the supplied text is insufficient.

**Report summary contract** (`report-summary-v1`) — strict structured JSON
with deep-extraction fields: `summary`, `one_sentence_summary`, `key_takeaways`
(3–8), `important_findings` (3–8), `deep_insights` (3–8), `mental_models`
(1–6), `practical_implications`, `recommendations`, `methodology_and_limitations`,
`activity_context`, `quotes`, `references`, and a `read_verdict`. Array fields
are bounds-checked; all fields are required unless explicitly nullable.

The application must implement a provider adapter with a stable internal
interface. Provider and model selection must be configurable without changing
the processing pipeline.

Provider calls must have bounded timeouts, classify retryable and permanent
errors, and record the provider/model version and usage where supplied.
Invalid structured output is a failed stage, not a successful empty result.

## 7. Jev Rubric

Rubrics are versioned configuration, not hard-coded assumptions in the UI.

The baseline pipeline uses one full Jev pass after normalisation. It produces
the labels, scores, inspectable signals, and triage inputs defined below. An
optional coarse pass may run before the full pass as a high-recall filter, but
it must not decide final ranking, freshness, or personal importance.

When enabled, the coarse pass returns:

- `decision`: `keep`, `monitor_only`, or `reject`
- `reason_code`: a stable machine-readable reason
- `confidence`
- `promotional_signal`
- `evidence_signal`
- `profile_match_signal`

The following hard rules apply after an optional coarse pass:

- A low-confidence `reject` becomes `monitor_only`.
- A story with a strong profile match cannot be rejected solely for weak wording.
- Promotional or safety-sensitive content may be retained as `monitor_only`
  but cannot become `read_now` without explicit evidence and personal relevance.
- A high-magnitude or widely corroborated story is never silently discarded by
  the coarse pass; it becomes `monitor_only` for the full pass.

### 7.1 Choice questions

`primary_topic`:

- `ai`: artificial intelligence, models, governance, applications
- `cybersecurity`: security, cyber risk, threats, resilience, privacy
- `geopolitics`: geopolitics, national security, defence, intelligence, state power
- `technology_strategy`: technology adoption, platforms, transformation
- `executive_decision_making`: leadership, governance, operating decisions
- `business_opportunity`: commercial, advisory, investment, or career relevance
- `other`: does not fit the focus areas

`content_type`:

- `analysis`
- `news`
- `research`
- `opinion`
- `how_to`
- `interview`
- `announcement`
- `other`

### 7.2 Score questions

Each score uses a five-level rubric from 0 to 4. The meaning of each level must
be included in the Jev request.

`quality_score`:

- 0: little substance, promotional, repetitive, or unusable
- 1: limited substance or weakly supported claims
- 2: useful but ordinary or uneven
- 3: strong analysis, evidence, or explanation
- 4: exceptional insight, originality, evidence, and lasting value

`personal_utility_score`:

- 0: unrelated to current interests
- 1: tangentially relevant with no clear use
- 2: relevant background or context
- 3: directly useful for work, research, writing, or decisions
- 4: immediately actionable or strategically important

`actionability_score`:

- 0: no identifiable implication or action
- 1: vague implication
- 2: useful implication but no clear next step
- 3: clear practical action or decision implication
- 4: specific, high-value action that should be considered promptly

### 7.3 Noul questions

Noul is a set of inspectable Jev signals, not an additional label taxonomy.
Noul results are retained and shown in expanded scoring details, but do not
change ranking or automatically hide items in the baseline build.

- Does the document contain a concrete claim supported by evidence?
- Does it contain a reusable mental model or framework?
- Does it contain a concrete action relevant to the user's focus?
- Is it likely to be worth sharing with an executive audience?
- Does it appear primarily promotional or low-signal?

The application must retain Noul results but should not automatically hide low
confidence items in the first version.

### 7.4 Freshness, evidence, and provenance

Freshness is an explicit pipeline result and must not be inferred only from the
Readwise ingestion timestamp. For every retained story, determine where
possible:

- `source_published_at`: when the observed source published the item
- `source_updated_at`: when the observed source last changed it
- `first_public_at`: when the underlying event or story first became public
- `new_development_at`: when the material new development occurred
- `freshness_status`: `new_development`, `new_reporting_old_event`, `ongoing`,
  `stale`, or `unverified`
- `freshness_confidence`: `high`, `medium`, or `low`

The system must distinguish an article newly added to Readwise from a genuinely
new event. When the first-public timestamp cannot be established, the item may
remain visible but must be marked `unverified` and cannot be promoted to
`read_now` solely because it is recent in Readwise.

Every story must also carry:

- `evidence_status`: `corroborated`, `single_source`, `conflicting`, or
  `unverified`
- `source_count`: number of distinct sources in the cluster
- `independent_source_count`: number of sources judged independent
- a primary source-of-record URL
- related source URLs with their provenance and timestamps

Model-proposed links or dates must never silently replace the source originally
retrieved. They must be marked as proposed and unverified until confirmed.

Freshness is deterministic when it can be derived from source metadata and
stored observations. Model assistance may propose `first_public_at`,
`new_development_at`, or a freshness classification when metadata is
insufficient, but those values remain explicitly proposed and unverified. A
model proposal alone cannot make an item `new_development` with high confidence
or promote it to `read_now`.

When no external source data establishes when an event first became public, the
system must use `freshness_status=unverified` and `freshness_confidence=low`.
The Readwise `created_at` timestamp is ingestion evidence only and must never
be used as evidence that an underlying event is new. A source publication date
may support `new_reporting_old_event` or `stale`, but cannot establish a new
development without an explicit material-change signal.

Evidence and independence are evaluated conservatively within the source set
available to the application:

- The same canonical URL is a duplicate, not corroboration.
- Near-identical content, syndicated content, or sources with a known common
  origin are related coverage, not independent sources.
- Distinct sources with materially different content may be counted as
  potentially independent only when their provenance and relationship are not
  contradictory.
- Unknown relationships are not counted as independent.
- Model-inferred relationships are stored as proposed until confirmed by
  deterministic evidence or an explicit user/operator action.

The system must store the method, confidence, and explanation for each
source-relationship determination. `corroborated` therefore means corroborated
within the retained source observations, not independently verified against the
entire public web.

In the baseline (no clustering), every document is conservatively
`single_source` with `source_count=1`, `independent_source_count=0`, and
`freshness_status=unverified` unless source metadata safely supports a
classification. This is intentional: most items correctly land in `watch`.

### 7.5 Triage rules and precedence

Triage is a separate judgement from numerical ranking. The full evaluation must
return a proposed `triage_state` and `triage_reason`; the application must
validate the proposal and enforce the deterministic rules below.

Rules are applied in this exact order; the first matching rule decides:

1. **Archive rules** (skipped entirely for consequential stories — a large or
   consequential story is never archived solely for being promotional, weakly
   fitting, low-scoring, or duplicated):
   - duplicate → `archive` (`duplicate`)
   - promotional → `archive` (`promotional`)
   - outside profile → `archive` (`outside_profile`)
   - below the configured display threshold → `archive` (`below_threshold`)
2. **Demotion rules**:
   - conflicting evidence → `watch` (`conflicting_evidence`)
   - unverified evidence → `watch` (`freshness_unverified`)
   - unverified freshness → `watch` (`freshness_unverified`)
3. **Promotion rules**:
   - proposed `read_now` with personal utility ≥ 3 and (actionability ≥ 3 or a
     documented strategic implication) → `read_now` (`high_utility_actionable`)
   - proposed `important_context` with a non-none profile match →
     `important_context` (`important_context_no_action`)
4. **Fallback**: → `watch` with `insufficient_personal_fit` (weak personal fit)
   or `model_proposal_not_supported` (promotion rules unsatisfied).

The application must store a deterministic `triage_reason_code` from the
following set: `high_utility_actionable`, `important_context_no_action`,
`freshness_unverified`, `single_source`, `conflicting_evidence`, `duplicate`,
`promotional`, `outside_profile`, `below_threshold`,
`insufficient_personal_fit`, `model_proposal_not_supported`.

### 7.6 Report rubric and ranking

Report evaluation uses six typed questions, each scored 0–4 with the same
level-inclusion requirement as §7.2, plus two boolean signals:

- `quality_score` — overall substance and writing quality
- `methodology_quality_score` — rigour, transparency, and fitness of method
- `strategic_relevance_score` — relevance to the active intelligence profile
- `novelty_score` — new insight versus known material
- `decision_utility_score` — usefulness for decisions the user must make
- `contains_evidence` (boolean) — the report presents evidence for claims
- `primarily_promotional` (boolean) — vendor marketing or collateral

Report ranking (`report-ranking-v1`) converts each score to 0–100
(`(score / 4) * 100`) and computes:

```text
report_final_score =
  quality * 0.25 +
  methodology * 0.20 +
  strategic_relevance * 0.25 +
  novelty * 0.15 +
  decision_utility * 0.15
  − 15 if primarily_promotional
```

Weights must be non-negative, sum to 1, and live in versioned configuration.
Report ranking must not silently reuse News weights or the News triage model;
Reports are surfaced by score and observation window, not by News triage
states.

## 8. Ranking

Convert each Jev five-level score to a 0–100 scale using
`normalized_score = (jev_score / 4) * 100`, then calculate:

```text
final_score =
  normalized_quality * 0.45 +
  normalized_personal_utility * 0.40 +
  normalized_actionability * 0.15
```

The coefficients must be stored in versioned configuration. The UI displays
the component scores so the final score is explainable. Quality and personal
utility are the primary axes; actionability is an explicit third component.

Confidence may be displayed and used for filtering later, but must not silently
override a score in the initial release.

**Feed ordering.** The default sort (`score`) is:

1. `final_score` descending
2. publication recency descending — `source_published_at` when it includes a
   time component, otherwise the document's creation timestamp
3. stable feed-item ID ascending (deterministic tie-break)

The alternative sort (`recent`) reverses the first two keys. Ordering must be
deterministic for a given feed query and configuration version. When clustering
is enabled, a story cluster receives one feed rank; otherwise each eligible
document receives one feed rank.

The final score must never be treated as permission to promote an item to
`read_now`. Triage rules (§7.5), evidence, freshness, and the active editorial
brief remain authoritative.

## 9. Processing Pipeline

### 9.1 Stage order

1. A supervised scheduler starts source polling on the configured cadence. The
   default deployment runs the scheduler inside the long-lived Bun process; a
   future deployment may use an external cron trigger to invoke the same run
   functions.
2. Pending processing work is claimed with bounded concurrency and persisted
   state. No in-memory background task may be the only record of work that must
   survive a restart.
3. The sync job fetches Readwise documents after the stored watermark.
4. The job filters by the configured `created_at` window, or by the recovery
   maximum when catching up after a missed sync.
5. Source adapters emit normalised observations with provenance and source
   timestamps; documents are then normalised into plain text and canonical
   metadata.
6. Documents over 40,000 normalised characters are truncated at a paragraph
   boundary (bounded word fallback for a single oversized paragraph) and marked
   `content_truncated=true`.
7. The system computes a SHA-256 content hash and checks for duplicates for the
   same document revision.
8. If story clustering is enabled, candidate document versions are clustered
   before full evaluation using canonical URL, stable source identity, title
   similarity, and content similarity. Each cluster gets one primary source;
   other documents become related coverage or duplicates. Without clustering,
   each document version proceeds as an independent feed candidate.
9. Processing work targets a sync, document version, or story cluster.
   Processing workers claim pending work, set a bounded lease, and process it
   independently. A job may create the next stage's idempotent job only after
   its own stage is durable.
10. The optional coarse Jev pass rejects only obvious low-value candidates and
    retains its decision and reason. The full Jev pass evaluates retained
    candidates.
11. The system applies freshness, evidence, and triage rules (§7.4, §7.5), then
    calculates component and final scores (§8).
12. The summary model generates validated structured prose for non-archive
    items (§6.6).
13. The candidate is published according to §9.3.
14. The global watermark advances only after every page in the sync has been
    safely persisted. Individual processing failures create retryable jobs and
    must not lose imported documents.

Freshness, evidence, and triage are applied after full evaluation and before
ranking and publication. Stage artifacts must allow an operator to inspect
fetched candidates, skipped items, evaluations, triage decisions, and published
stories. Clustering and coarse-pass artifacts are required only when those
optional extensions are enabled.

### 9.2 Idempotency, retries, and leases

Processing must be idempotent for the tuple of source name, source document ID,
content hash, rubric version, prompt version, provider model versions, and
processing stage. Re-running a failed job must not create duplicate documents,
evaluations, summaries, or feed stories.

**Retries (single rule):** jobs may be retried up to three times with bounded
exponential backoff before being marked failed. The summary stage retries
transient provider failures up to 2 times (configurable) within that budget;
a permanent summary failure marks the stage failed immediately. After final
failure, retry is an explicit action (§5.5), never an automatic loop.

Expired leases return jobs to the pending state. Reprocessing an existing
version requires an explicit job for the selected rubric, profile, prompt,
ranking, and provider model versions. Evaluation and summary generation run
once per feed candidate by default. When clustering is enabled, they may run
once per story cluster using the primary document and related-coverage
metadata. Document-level reprocessing is an explicit operator action.

Every adapter must emit normalised observations with provenance and source
timestamps before common processing begins.

### 9.3 Publication, withdrawal, and retention

**Publication transitions:**

1. An evaluated **non-archive** item is persisted with
   `publication_status=summary_pending`. It becomes `published` only when a
   validated summary is attached. News feed queries return only `published`
   items; pending items remain available for retry and diagnostics.
2. An **archive** item is published immediately without a summary (no summary
   is generated for it). It is excluded from the default view by the default
   triage filter, not by publication status.
3. If summary generation ultimately fails (§9.2), the item remains
   `summary_pending` and is surfaced in diagnostics with a pending count, so a
   backlog cannot grow silently. Recovery is explicit retry of the summary
   stage.
4. Re-evaluation under a new prompt/rubric/config version withdraws the
   previous publication (`publication_status=withdrawn`, `superseded_at` set)
   so the UI shows only the current evaluation. Only one non-superseded
   publication may exist per evaluated candidate.

**Retention (single rule):**

- News: a scheduled purge runs at startup and before each News sync, deleting
  all News content older than three days. Age is the publication date when it
  includes a time component, otherwise the document's creation timestamp.
  Deletion cascades in order: summaries → evaluations → triage decisions →
  feed items → document versions → documents. This applies to every triage
  state, including `archive`: archive is a display filter, not archival.
  Cursor pagination therefore browses within the retained three-day window.
- Reports: active view is a 72-hour observation window; provenance/version
  records are retained for deduplication and re-evaluation (§5.5).
- CVEs: retained seven days (§4.2).

## 10. Data Model

Column types are SQLite. Timestamps are UTC ISO-8601 text. Foreign keys are
enforced. `*_json` columns hold validated JSON.

Two timestamp conventions apply throughout, and implementations must not
conflate them:

- **Local persistence time:** `created_at` / `updated_at` — when the row was
  created or last changed by this application.
- **Source time:** `created_timestamp` / `updated_timestamp` (and `published_at`
  / `source_published_at` where present) — timestamps as reported by the
  upstream source. The ingestion window filter uses the source's creation
  timestamp, never the local row time.

### 10.1 News core

#### `documents`

Stable source identity and current metadata.

- `id`
- `source_name`
- `source_item_id`
- `readwise_id` — nullable; unique where present (Readwise records only)
- `source_url`
- `readwise_url` — nullable
- `title`
- `author` — nullable
- `site_name` — nullable
- `category` — source format (`rss`, `video`, `news`, `article`, `email`)
- `published_date` — nullable
- `saved_at` — nullable; display only, never a filter (§17)
- `created_at` — local row creation
- `updated_at` — local row update
- `created_timestamp` — source creation time (ingestion filter basis)
- `updated_timestamp` — source update time

Unique `(source_name, source_item_id)`.

#### `document_versions`

Normalised content snapshots.

- `id`
- `document_id` — FK, `ON DELETE CASCADE`
- `content_hash`
- `normalized_text`
- `word_count`
- `content_truncated` (0/1)
- `source_updated_timestamp` — nullable
- `ingested_at`

Unique `(document_id, content_hash)`.

#### `evaluations`

Validated Jev results and deterministic ranking.

- `id`
- `document_version_id` — FK; the primary document version used as evaluation
  input, retained for document-level reprocessing
- `story_cluster_id` — nullable; populated only when clustering is enabled
- `rubric_version`
- `profile_version`
- `jev_model`
- `prompt_version`
- `ranking_config_version`
- `coarse_decision` — nullable
- `coarse_reason_code` — nullable
- `evidence_signal`, `promotional_signal`, `profile_match_signal` — nullable
- `proposed_triage_state`, `proposed_triage_reason`
- `strategic_implication` — nullable
- `quality_score`, `personal_utility_score`, `actionability_score` (0–4)
- `final_score`
- `primary_topic`, `content_type`
- `noul_results_json`, `probabilities_json`, `confidence_json`
- `jev_response_json`, `jev_usage_json`
- `evaluated_at`

Unique `(document_version_id, rubric_version, profile_version, jev_model,
prompt_version, ranking_config_version)`. Identity is keyed on the document
version — not on `story_cluster_id` — so the disabled-clustering baseline has
no NULL-key uniqueness trap. Cluster linkage is metadata, not identity.

#### `triage_decisions`

- `id`
- `evaluation_id` — FK, unique; one decision per evaluation
- `proposed_triage_state`, `proposed_triage_reason`
- `triage_state` (`read_now`, `important_context`, `watch`, `archive`)
- `triage_reason_code` (§7.5 enumeration)
- `triage_reason`
- `enforced_rules_json`
- `profile_version`
- `created_at`

The application must store both the model proposal and the deterministic rules
that enforced or changed it. A new evaluation creates a new decision; existing
decisions are never overwritten.

#### `summaries`

- `id`
- `document_version_id` — FK
- `evaluation_id` — FK
- `summary_provider`, `summary_model`, `summary_model_version`
- `summary`, `why_it_matters`, `key_points_json`, `recommended_action`
- `prompt_version`
- `usage_json`, `raw_response_json`
- `status` (`pending`, `completed`, `failed`)
- `generated_at`

#### `feed_items`

The durable publication projection used by feed queries. It records which
evaluated version is visible without mutating historical evaluations or triage
decisions.

- `id`
- `document_version_id` — FK
- `evaluation_id` — FK, unique (one publication per evaluation)
- `summary_id` — nullable FK
- `story_cluster_id` — nullable; only when clustering is enabled
- `publication_status` (`published`, `summary_pending`, `withdrawn`)
- `triage_state`, `triage_reason_code`, `triage_reason`
- `freshness_status`, `freshness_confidence`, `evidence_status`
- `source_count`, `independent_source_count`
- `final_score`
- `published_at`
- `superseded_at` — nullable

News feed queries return only `publication_status='published'` (§9.3).
`summary_pending` and `withdrawn` remain queryable for diagnostics.

#### Clustering extension tables (optional)

`story_clusters`, `story_cluster_members`, and `source_relationships` exist
only when clustering is enabled; they must not change News, Reports, or CVE
collection boundaries, and their linkage into `evaluations`/`feed_items` is
via the nullable `story_cluster_id` columns above.

- `story_clusters`: `id`, `cluster_key` (unique),
  `primary_source_observation_id`, `first_public_at` (nullable),
  `new_development_at` (nullable), `freshness_status`, `freshness_confidence`,
  `evidence_status`, `source_count`, `independent_source_count`,
  `cluster_confidence`, `cluster_method` (`deterministic`, `model_assisted`,
  `manual`), `cluster_explanation`, `created_at`, `updated_at`.
- `story_cluster_members`: `story_cluster_id`, `document_version_id`,
  `membership_type` (`primary`, `related`, `duplicate`),
  `membership_confidence`, `membership_reason`, `created_at`. Unique
  `(story_cluster_id, document_version_id)`; at most one `primary` member per
  cluster.
- `source_relationships`: `id`, `story_cluster_id`, `source_observation_id`,
  `related_source_observation_id`, `relationship` (`duplicate`, `syndicated`,
  `related`, `potentially_independent`, `unknown`), `independence_status`
  (`independent`, `not_independent`, `unknown`), `confidence`, `method`,
  `explanation`, `proposed`, `created_at`. Pairs stored in canonical order,
  unique within a cluster.

#### `source_observations`

- `id`
- `source_name`, `source_item_id`
- `document_version_id` — nullable until normalisation completes
- `source_url`, `canonical_url`
- `source_published_at` — nullable
- `source_updated_at` — nullable
- `retrieved_at`
- `source_content_hash` — nullable
- `provenance_level` (`primary`, `secondary`, `aggregator`, `unknown`)
- `source_metadata_json`
- `content_unavailable_reason` — nullable

Unique `(source_name, source_item_id, source_updated_at, source_content_hash)`
where supported. Because nullable SQLite columns do not provide revision
uniqueness by themselves, the application must derive a stable revision key
from the source update timestamp or normalised content hash.

### 10.2 Reports collection

#### `reports`

- `id`
- `source` (`orkl`, `rosti`, `github_annual_reports`)
- `provider_report_id`
- `canonical_url`
- `source_index_url` — nullable
- `title`
- `report_year` — nullable
- `report_type` (`threat_intelligence`, `annual_analysis`, `survey`,
  `research`, `other`)
- `source_published_at`, `activity_start_at`, `activity_end_at` — nullable
- `observed_at`
- `updated_at` — source update time; nullable
- `temporal_classification`
- `metadata_json`
- `created_at` — local
- `last_seen_at`

Unique `(source, provider_report_id)`.

#### `report_versions`

- `id`
- `report_id` — FK, `ON DELETE CASCADE`
- `content_hash`
- `normalized_text`
- `word_count`
- `content_truncated` (0/1)
- `content_format` (`markdown`, `pdf`)
- `source_updated_at` — nullable
- `ingested_at`

Unique `(report_id, content_hash)`.

#### `report_evaluations`

- `id`
- `report_version_id` — FK, `ON DELETE CASCADE`
- `rubric_version`, `prompt_version`, `ranking_config_version`
- `report_type`, `primary_topic`, `activity_status`
- `quality_score`, `methodology_quality_score`, `strategic_relevance_score`,
  `novelty_score`, `decision_utility_score` (0–4, §7.6)
- `contains_evidence` (0/1), `primarily_promotional` (0/1)
- `final_score`
- `raw_response_json`
- `evaluated_at`

Unique `(report_version_id, rubric_version, prompt_version,
ranking_config_version)`.

#### `report_summaries`

- `id`
- `report_version_id` — FK, `ON DELETE CASCADE`
- `provider`, `model`, `prompt_version`
- `read_verdict`
- `summary`, `one_sentence_summary`
- `key_takeaways_json`, `important_findings_json`, `deep_insights_json`,
  `mental_models_json`, `practical_implications_json`, `recommendations_json`
- `methodology_limitations`, `activity_context`
- `quotes_json`, `references_json`
- `raw_response_json`
- `generated_at`

Unique `(report_version_id, prompt_version)`.

#### `report_discovery_runs`

- `id`
- `started_at`, `finished_at` — nullable until finished
- `status` (`running`, `completed`, `failed`)
- `candidates_found`, `failures_count`
- `current_source`, `current_stage` — nullable progress markers
- `error_message` — nullable

### 10.3 CVE collection

#### `vulnerabilities`

- `id`
- `cve_id` — unique
- `source_id`
- `title`, `description`
- `published_at`, `modified_at` — nullable
- `cvss_score` — nullable
- `severity` (`critical`, `high`, `medium`, `low`, `unknown`)
- `cvss_vector` — nullable
- `affected_products_json`
- `exploitability` — nullable
- `mitigation` — nullable
- `references_json`
- `raw_json`
- `first_seen_at`, `last_seen_at`

#### `vulnerability_runs`

- `id`
- `started_at`, `finished_at` — nullable until finished
- `status` (`running`, `completed`, `failed`)
- `records_found`, `records_stored`, `records_skipped`, `failures_count`
- `error_message` — nullable

### 10.4 Authentication

#### `users`

- `id`
- `email` — unique
- `created_at`
- `last_login_at` — nullable

#### `magic_link_tokens`

- `id`
- `email`
- `token_hash` — unique; only the hash is persisted
- `created_at`
- `expires_at` (15 minutes after creation)
- `consumed_at` — nullable
- `request_ip` — nullable

Consuming a token must be atomic and must fail if it is expired or already
consumed.

#### `auth_sessions`

- `id`
- `user_id` — FK
- `session_hash` — unique
- `csrf_token_hash`
- `created_at`
- `expires_at` (30 days in the baseline build)
- `revoked_at` — nullable

Session cookies contain opaque random values only. Session lookup uses the
stored hash, and logout sets `revoked_at` rather than deleting audit history.

### 10.5 Operational

#### `sync_runs`

- `id`
- `trigger` (`scheduled`, `manual`, `recovery`, `backfill`)
- `status` (`running`, `completed`, `failed`, `partial`)
- `started_at`, `finished_at` — nullable until finished
- `watermark_before`, `watermark_after`, `watermark_overlap_seconds`
- `items_found`, `items_persisted`, `items_skipped`
- `stories_created`, `duplicates_collapsed`
- `source_health_json`
- `error_code` — nullable
- `error_message` — nullable

`partial` marks a sync that completed with per-page or per-item failures but a
retained watermark (§6.1).

#### `sync_skips`

Per-run record of filtered/skipped documents:

- `id`, `sync_run_id` (FK), `document_version_id` (nullable), `reason_code`,
  `created_at`.

#### `processing_errors`

- `id`
- `sync_run_id` — FK
- `document_version_id` — nullable FK
- `stage`
- `error_code`
- `safe_message`
- `retry_count`
- `last_attempt_at`
- `resolved_at` — nullable

#### `processing_runs`

- `id`
- `target_type` (`document_version`, `story_cluster`, `sync_run`)
- `target_id`
- `sync_run_id` — nullable FK
- `stage`
- `status`
- `attempt_count`
- `error_code`, `error_message` — nullable
- `skip_reason` — nullable
- `started_at`, `finished_at` — nullable

#### `jobs`

- `id`
- `target_type` (`document_version`, `story_cluster`, `sync_run`)
- `target_id`
- `job_type`
- `idempotency_key` — unique
- `status` (`pending`, `processing`, `completed`, `failed`)
- `attempt_count`
- `available_at`
- `lease_expires_at`, `lease_owner`
- `last_error`
- `created_at`, `updated_at`

Jobs are uniquely identified by target, stage, and the relevant configuration
versions. The default worker claims one job per invocation; any future batch
size must remain configurable and bounded by the invocation processing budget.

#### `settings`

Versioned, non-secret configuration: `id`, `version`, `active`, ingestion
window, recovery maximum age, rubric version, ranking coefficients, minimum
display score, last successful sync watermark, active intelligence profile
version, active prompt and provider versions, active ranking configuration
version.

A settings change creates a new version and becomes active only after
validation. Changing the active rubric or ranking does not automatically
reprocess existing content; reprocessing is an explicit action. Settings must
not contain the editorial brief or profile contents (those belong to
`intelligence_profiles`) or any secret (§12).

#### `system_locks`

- `lock_name` — unique
- `lease_owner`
- `lease_expires_at`
- `acquired_at`, `updated_at`

The `readwise_sync` lock prevents scheduled, manual, recovery, and backfill
syncs from running concurrently. Expired locks may be safely reclaimed.

#### `intelligence_profiles`

- `id`
- `version` — unique
- `active`
- `topics_json`, `named_entities_json`, `current_decisions_json`,
  `preferred_source_types_json`, `exclusions_json`
- `editorial_brief` — plain text
- `created_from` (`initial`, `user_edit`, `feedback_proposal`)
- `created_at`, `confirmed_at` — nullable until confirmed

Only one profile version may be active. Historical evaluations retain the
profile version used at processing time. The editorial brief is user-owned
prose: the application stores and versions it but does not attempt to infer
hidden preferences from behaviour.

#### `feedback_proposals`

- `id`
- `feedback_text`
- `proposed_change_json`
- `target` (`profile`, `editorial_brief`, `rubric`)
- `status` (`proposed`, `confirmed`, `rejected`)
- `created_at`, `resolved_at` — nullable until resolved

#### Indexes

Add indexes for: source identity, Readwise ID, document-version lookups, job
status and availability, sync timestamps, feed ordering
(`publication_status`, `final_score`, `published_at`), report `last_seen_at`,
and vulnerability `published_at`/`severity`. Enforce uniqueness for
`(source_name, source_item_id)` on stable document identity, the
document-version content hash, the derived source-observation revision key, and
the job idempotency key.

## 11. Failure Handling

The system must distinguish:

- **Authentication failures:** stop and alert clearly.
- **Rate limits:** retry with bounded exponential backoff using `Retry-After`.
- **Transient provider errors:** retry up to the configured limit (§9.2).
- **Invalid provider output:** mark failed and retain the raw response.
- **Retained raw provider responses** must be redacted, bounded, and associated
  with the processing stage; request headers, credentials, and full article
  text must never be retained in operational errors.
- **Jev success followed by summary failure:** retain the evaluated item with
  `summary_pending` and retry summary generation independently (§9.3). The
  feed hides it until a completed summary is attached; diagnostics and the
  database retain the pending/failed state for recovery.
- **Cluster-resolution failure:** retain the documents as separate `watch`
  items, record the failure, and never silently merge potentially unrelated
  stories.
- **Conflicting source evidence:** retain the story as `watch` or
  `important_context`, show the disagreement, and prevent automatic promotion
  to `read_now` until resolved (§7.5).
- **Unsupported or empty content:** mark skipped with a stable reason code.
- **Oversized content:** apply the configured truncation policy and record it.

One failed document must not prevent other documents from being processed.

## 12. Security and Privacy

- Store all provider credentials using VPS environment configuration or an
  equivalent encrypted secret store. Required secrets/configuration include:
  - `READWISE_API_TOKEN`
  - `TYPESAFE_API_KEY` for Jev
  - `SUMMARY_API_KEY` (or the selected model-provider credential),
    `SUMMARY_PROVIDER`, `SUMMARY_MODEL`
  - `ROSTI_API_KEY` when ROSTI is enabled
  - `EMAIL_SERVER`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS` for SMTP
    magic-link delivery
  - `EMAIL_FROM` for the verified magic-link sender
  - `AUTH_ACCESS_MODE` (`public` or `allowlist`)
  - `AUTH_APPROVED_EMAIL` when allowlist mode is used
  - `AUTH_BASE_URL` for the public HTTPS application URL
  - Any provider-specific gateway credential required by the selected model
- Never store API keys in SQLite, source control, `SPEC.md`, client
  configuration, browser storage, or request payloads returned to the frontend.
- Never commit development `.env` files; provide a checked-in `.env.example`
  containing names only and no values.
- Use separate secrets for development, preview, and production where supported.
- Restrict each credential to the minimum available permissions and service scope.
- Document a rotation procedure and rotate credentials immediately if exposed.
- Never expose provider credentials to browser JavaScript.
- Protect the application with passwordless magic-link authentication (§5.7).
  In the public demo, any syntactically valid email may request a link; in
  allowlist mode, only `AUTH_APPROVED_EMAIL` may authenticate.
- Do not store passwords. Store only hashed, single-use, time-limited
  magic-link tokens and server-side authenticated sessions. Authentication uses
  Secure, HttpOnly, SameSite cookies in HTTPS deployments, plus CSRF/origin
  protection for state-changing requests.
- Do not expose account-management endpoints. Public demo access creates only
  the minimal application user/session record required for authentication and
  does not expose profile, role, or billing controls.
- Validate all outbound URLs and only allow `http` and `https` links; reject
  localhost, private-network, and otherwise unsafe linked URLs before fetching.
- Do not render untrusted article HTML; sanitise or render plain text through
  safe DOM text nodes.
- Avoid logging full article contents or credentials.
- Require authentication and rate limits for manual sync, retry, reprocessing,
  settings changes, and deletion. No operational endpoint may be public or
  unauthenticated.
- Provide per-document content purge that removes normalised article text and
  retained raw provider payloads from all revisions while retaining minimal
  metadata and typed evaluation results. The baseline build must not persist
  raw Readwise HTML. Raw Jev and summary responses may be retained only when
  required for audit or debugging, must be redacted and bounded, and must be
  removed by the same purge operation. Logs, error messages, and stage
  artifacts must follow the same content-redaction policy.
- Protect state-changing endpoints against CSRF and set appropriate security
  headers, including a restrictive Content Security Policy. The baseline does
  not render remote article images (§5.4), so the CSP need not allow foreign
  image origins.
- Document retention and provider data-processing implications before
  production use.

## 13. Observability

Record structured metrics for:

- Documents fetched, skipped, processed, and failed
- Jev latency, token usage, and errors
- Summary-model latency, token usage, and errors
- Queue depth and retry counts
- Processing completion time
- Estimated cost per document and per sync
- Stories created, duplicate documents collapsed, and average cluster size
- Counts by triage state, freshness status, and evidence status
- Source-level fetch success, partial failure, rate limiting, and
  missing-source counts
- Reports discovery run age, active source/stage, timeout recovery, candidates
  found, and per-source failures
- CVE polling records found, normalised, skipped, failed, and retained
- Coarse-pass rejection rate and full-pass promotion rate
- Count of items stuck in `summary_pending` beyond one sync cycle (backlog
  visibility, §9.3)

Persist durable sync, job, and processing records in SQLite. Emit runtime
diagnostics as structured application logs; an external monitoring service is
not required for the baseline build.

The admin view should show the latest sync time, number of items found, and
current failures.

## 14. Testing and Evaluation

### Automated tests

- Readwise pagination and watermark handling
- 12-hour timestamp filtering (both boundaries; future timestamps rejected)
- Category filtering
- HTML-to-text normalisation
- Content hashing and deduplication
- Source adapter normalisation and partial source failure handling
- Story clustering, primary-source selection, and duplicate collapse (when enabled)
- Freshness classification for new activity versus new reporting
- Evidence/provenance rendering and conflicting-source handling
- Coarse-pass hard rules and triage-state enforcement, including rule
  precedence (§7.5) and consequential-story protection
- Jev response validation (choice, score, Noul, missing/unexpected questions)
- News and report summary JSON validation
- Report ranking weights and promotional penalty
- Ranking calculations and deterministic tie-breaking
- Retry and failure state transitions
- URL validation and HTML sanitisation
- Job lease expiry and recovery
- Document revision handling and latest-revision feed selection
- Feed cursor pagination (both sorts)
- Publication transitions: `summary_pending` → `published`, withdrawal on
  re-evaluation, archive immediate publication (§9.3)
- Retention purge cascade and boundary (§9.3)
- Magic-link expiry, single use, session expiry, and authorisation

### Evaluation set

Create a manually reviewed set of 50–100 representative documents. Record
expected topic labels and approximate quality/utility scores. Compare Jev
results against this set before relying on the feed. This is a documented
baseline and disagreement-review exercise, not a hard launch gate.

The evaluation must be repeatable by rubric version and model version.

### Decision gate

After the two-week daily-use window (§2.1), record a written proceed/defer
decision covering: whether triage time was reduced, whether rankings were
useful, whether summaries were trustworthy, whether provider cost and latency
are acceptable, and which post-baseline features (§15) are justified by
measured need.

## 15. Acceptance Criteria

The baseline build is complete when:

- Startup and scheduled collection imports Readwise documents added in the
  previous 12 hours; an administrative/manual API trigger may also be provided,
  but the primary UI does not require a Sync button.
- Pagination and rate limiting work without duplicate documents.
- Unsupported document types are skipped with a visible reason.
- Jev labels and scores every retained eligible feed item with validated
  structured data. If a coarse pass is enabled, rejected candidates retain
  their validated decision and reason.
- The summary model produces validated summary fields for successful items;
  failed summaries leave items in a visible, retryable `summary_pending` state
  with a diagnostics count (§9.3).
- The ranked feed displays scores, labels, summaries, and source links, ordered
  by the deterministic §8 contract.
- The feed is usable on desktop and mobile and provides loading, empty,
  partial-processing, error, and retry states.
- Quality and utility scores remain separately visible.
- A rubric version and provider model version are stored for each result.
- Failed items can be retried without duplicating results.
- Changed Readwise content is retained as a new version and the normal feed
  shows only the latest successfully processed version.
- Recovery imports missed documents up to the configured 30-day maximum.
- A Jev-evaluated non-archive feed item is persisted with
  `publication_status=summary_pending` while summary generation is pending, and
  shown in the feed only after summary completion; archive items publish
  without summaries and are hidden from the default view by the triage filter.
- News content older than three days is removed by the retention purge with
  the defined cascade; Reports and CVEs follow their own retention windows.
- Provider credentials are not present in client responses or browser code.
- In public demo mode, a syntactically valid email can authenticate through a
  time-limited single-use magic link; allowlist mode restricts authentication
  to `AUTH_APPROVED_EMAIL`. Passwords are not supported.
- Protected routes return `401` or redirect to `/login`, health and static
  assets remain public, and logout revokes the server-side session.
- A representative evaluation set has been reviewed and documented.
- Estimated processing cost and latency are recorded (§2.1, §14).
- If clustering is enabled, duplicate coverage is collapsed into story clusters
  with a visible primary source and related coverage.
- The feed exposes freshness, evidence, provenance, and triage state for every
  non-archived item.
- Low-confidence or conflicting stories cannot be promoted automatically to
  `read_now`.
- The first-use journey produces a useful feed before optional source setup is
  requested.
- News and Reports are separate top-level collections with independent filters,
  sorting, pagination, URL state, evaluation prompts, ranking configuration,
  and summary contracts.
- Reports are discovered from ORKL, ROSTI, and the curated annual-report
  repository, with a 72-hour active observation window, preserved temporal
  provenance, and the report rubric/ranking of §7.6.
- Optional News adapters include Reddit, GitHub Trending, Mediastack, and
  YouTube; GitHub Trending evaluates substantive repository README content
  rather than ranking projects from Trending position alone.
- CVEs are collected independently from CIRCL with deterministic
  normalisation, severity/CVSS display, search, filters, pagination, and
  seven-day retention; they do not use Jev or summaries.
- Report publication/index dates are not treated as evidence that underlying
  activity is new.
- Direct profile and editorial-brief changes are versioned and do not alter
  historical evaluations. Feedback proposals, when enabled, are auditable and
  never silently change the active rubric or ranking.

### Baseline scope boundary

The baseline build is the smallest production system that can establish
whether this feed meaningfully improves reading triage (measured per §2.1).
It includes:

- one Readwise/RSS source adapter;
- passwordless access through public demo mode or a single-email allowlist;
- versioned rubric and ranking configuration (News and Reports);
- deterministic document normalisation and deduplication;
- full Jev evaluation with validated structured results;
- conservative freshness, evidence, provenance, and triage enforcement;
- one configurable summary provider;
- SQLite-backed run state, retries, recovery, feed publication, and diagnostics;
- a responsive feed with scores, explanations, source coverage, and persisted
  `summary_pending` handling that hides incomplete News cards; and
- a manually reviewed evaluation set and cost/latency baseline.

The following are post-validation enhancements and are not required to prove
the baseline build's usefulness:

- further source adapters and cross-source collection beyond the Reddit,
  GitHub Trending, Mediastack, YouTube, Reports, and CIRCL implementations;
- model-assisted clustering for unresolved candidates;
- external corroboration and richer event-level freshness research;
- feedback-to-profile or editorial-brief proposals;
- automatic rubric tuning or behavioural learning;
- multi-job batching beyond the initial bounded processing budget; and
- additional feed views, collaboration, multi-user roles, billing, or private
  per-user settings.

The baseline build may expose extension points for these capabilities, but
must not incur their operational or model cost before the evaluation baseline
justifies them.

## 16. Implementation Defaults

- Runtime: Bun on Linux for the default deployment implementation.
- Database: SQLite with ordered migrations, WAL-compatible backups, and
  repository-level persistence boundaries.
- Frontend: vanilla HTML/CSS/browser JavaScript served by the Bun application.
- Background processing: SQLite-backed run state, bounded in-process
  concurrency, retries, and idempotency keys; use systemd to supervise the
  long-running process on the VPS.
- Initial processing budget: bounded provider requests, a 10-minute Reports run
  budget, and bounded summary/report concurrency. Deployment-specific limits
  remain configurable.
- Authentication: passwordless magic-link login with `public` demo mode or
  `allowlist` private mode, server-side sessions, and SMTP delivery.
- Sync schedule: hourly scheduler checks with source-specific cadence guards,
  startup polling, and manual sync.
- Feed queries use cursor pagination, default sort `score` (§8), and default to
  the latest ingestion window with the minimum display score threshold (§4).
- Source collection uses a common adapter contract; Readwise/RSS is the
  required News adapter, with Reddit, GitHub Trending, Mediastack, YouTube,
  Reports, and CIRCL implemented as separate optional collection paths.
- The optional coarse pass may run before full Jev evaluation to reduce cost.
- Apply freshness, evidence, and triage rules before ranking and publication.
- Freshness and evidence are conservative: deterministic source metadata is
  authoritative, while model-assisted dates and relationships remain proposed
  and unverified. In the baseline, single-source/unverified defaults are
  intentional (§7.4).
- Use stable schedule offsets rather than assuming every source should run at
  the same minute; scheduled runs must record their trigger and offset. The
  default deployment runs News and Reports at startup and checks them hourly,
  while provider cadence overrides protect account-limited sources.
- Source cadence defaults: Reports and Reddit hourly, GitHub Trending every six
  hours, CIRCL CVEs every six hours, and Mediastack daily (§4.2). These are
  independent eligibility guards, not guarantees that a provider has new data.
- Report provider requests default to a 30-second timeout, report runs default
  to a 10-minute budget, stale runs recover after twice that budget, and report
  processing uses bounded concurrency. Diagnostics must make an empty provider
  result distinguishable from a failed or timed-out run.
- Recovery maximum: 30 days; normal ingestion window: 12 hours.
- Feed and sync timestamps are stored in UTC and displayed in the configured
  application timezone.
- Maximum provider input: 40,000 normalised characters, truncated at a
  paragraph boundary when necessary (§9.1).
- Testing: Vitest for unit tests; Bun test for integration and native SQLite
  tests (the Vitest Node runtime cannot import Bun's native SQLite module).
- Formatting: Prettier.
- Package/runtime tooling: Bun for development scripts where compatible.
- OpenCode: used for development, code changes, and maintenance; not invoked
  as the production summarisation service.

## 17. Validation and Operations Checklist

The following items require human access or confirmation before wider public
operation. They are operational validation requirements, not invitations for an
implementation agent to make product decisions.

### Provider validation and ongoing operations

Validate each selected provider with a small, non-production fixture set and
record the result. The validation must confirm:

- authentication format and secret scope;
- request and response schemas;
- maximum input size and supported content limits;
- timeout, retry, rate-limit, and error semantics;
- model/version identifiers returned by the provider;
- structured-output support for summary generation;
- token usage, pricing, and expected latency;
- data retention, training, and deletion implications; and
- representative behaviour on short, long, empty, malformed, promotional, and
  high-value documents.

Provider adapters may be implemented against typed test doubles before this
phase completes, but production credentials and provider-specific assumptions
must not be treated as confirmed until the validation results are recorded.

### Required accounts and credentials

- Readwise Reader account with an API token.
- TypeSafe account with Jev API access, API key, pricing, quotas, and request
  size limits confirmed.
- OpenCode Zen account or selected model-provider account with API access,
  authentication format, supported model identifier, usage limits, and
  structured-output support confirmed.
- SMTP-capable transactional email provider with a verified sender address and
  server credentials (`EMAIL_SERVER`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS`,
  and `EMAIL_FROM`).
- VPS account with SSH access, persistent storage, process supervision, and a
  public HTTPS access layer.

### Required deployment configuration

- Deploy the frontend and API as one supervised Bun application.
- Use SQLite for the baseline database and back it up off-host.
- Protect the demo site with passwordless magic-link authentication in public
  mode, or one configured approved email address in allowlist mode.
- Store production credentials using protected environment configuration or a
  server-side secret manager.
- Create separate development, preview, and production secret values where
  supported.

### Required product defaults

- Use the source's `created_at` as the ingestion timestamp (`created_timestamp`
  locally). `saved_at` may be retained for display but must not be used as a
  filter.
- Process only `article`, `rss`, and text-capable `email` documents.
- Store normalised plain text; do not persist raw HTML in the baseline build.
- Use a 40,000-character maximum input size. Oversized documents are truncated
  at a paragraph boundary and marked with `content_truncated=true`.
- Use direct model API calls for summaries; OpenCode is not a production
  runtime dependency.
- Use the confirmed provider/model identifier through a provider adapter so the
  application does not depend on a hard-coded model name.

### Required validation before launch

- Establish a manually reviewed evaluation set of 50–100 representative
  documents.
- Test representative short, long, empty, malformed, duplicate, and unsupported
  Readwise documents.
- Confirm Jev and summary-provider response schemas with live credentials.
- Confirm estimated cost and latency for a typical 12-hour sync.
- Confirm the secret rotation procedure.

## 18. Glossary

- **Jev** — TypeSafe's classification/scoring API (§6.5). Returns typed
  question results: Choice, Score, and Noul.
- **Noul** — a Jev result type returning numeric inspectable signals (§7.3)
  that may omit probability/confidence.
- **Coarse pass** — optional cheap high-recall pre-filter before full Jev
  evaluation (§7).
- **Triage state** — the four-level editorial disposition of an item (§5.2),
  enforced deterministically per §7.5.
- **Feed item** — a published projection of one evaluated document version
  (§10.1); the queryable unit of the News feed.
- **Source observation** — a normalised, provenance-tagged record emitted by a
  source adapter (§6.4).
- **Provenance level** — adapter-declared relationship of the observation to
  the original content: `primary`, `secondary`, `aggregator`, `unknown`.
- **Observation window** — the period during which an item is shown because the
  application observed it recently, independent of publication date (Reports).
- **Watermark** — the stored UTC high-water timestamp used for incremental
  Readwise sync (§6.1).
- **`summary_pending`** — persisted evaluated state awaiting a valid summary;
  hidden from the News feed until complete (§9.3).

## 19. Reference Documentation

- Readwise Reader API: https://readwise.io/reader_api
- TypeSafe Jev introduction: https://docs.typesafe.ai/introduction
- TypeSafe quick start: https://docs.typesafe.ai/introduction/quickstart
- OpenCode documentation: https://opencode.ai/docs
- CIRCL Vulnerability-Lookup (CVE API): https://cve.circl.lu/
- Mediastack API documentation: https://mediastack.com/documentation
- ORKL (Open Report Key Library): https://orkl.eu/
- ROSTI v2 API: see provider documentation and configured `ROSTI_API_KEY` scope
- Reddit Atom/RSS feeds: `https://www.reddit.com/r/<subreddit>.rss`
- GitHub Trending: https://github.com/trending

## Appendix A — Consolidation notes

This version consolidates several earlier drafts. The decisions taken while
consolidating are recorded here so they are auditable.

1. **Section ordering fixed** — the previous draft placed §5.4 before §5.3;
   subsections are now sequential.
2. **Feed ordering contradiction resolved** — earlier drafts stated three
   different default orders (highest score first; triage-state tiers; score
   with triage tie-break). The specified behaviour (triage tiers are
   definitions; feed sorts by final score with recency tie-break, §8) is now
   the single normative statement. Triage state is a filter; archive is hidden
   by the default filter, not by publication status.
3. **Retention contradiction resolved** — "archive retained for history" was
   inconsistent with three-day deletion and with cursor pagination. Retention
   is now one rule (§9.3): everything News, including archive, is purged after
   three days via a defined cascade; pagination browses within the retained
   window.
4. **Retry counts unified** — earlier drafts said both "two retries"
   (summaries) and "three times" (jobs). One rule now: three pipeline
   attempts, with the summary stage's transient retries defaulting to 2 within
   that budget (§9.2).
5. **Unclustered identity fixed** — a `feed_stories` projection keyed on a
   nullable `story_cluster_id` created a NULL-uniqueness trap in the
   disabled-clustering baseline. The projection is now `feed_items`, keyed on
   `evaluation_id`, with clustering as a purely additive extension.
   Evaluation identity is keyed on document version, not cluster (§10.1).
6. **Timestamp naming clarified** — `documents` carried both `created_at` and
   `created_timestamp` without definitions. §10 now defines local persistence
   time vs source time and names the ingestion-filter basis explicitly.
7. **`sync_runs` gained `partial`** — the watermark algorithm required a
   "failed or partial" outcome that the status enum did not have.
8. **Triage precedence codified** — archive/demotion/promotion order, the
   consequential-story protection, and the full reason-code set
   (`conflicting_evidence`, `insufficient_personal_fit`,
   `model_proposal_not_supported`) are now specified in full (§7.5).
9. **Reports and CVE data models added** — earlier drafts required both
   collections in acceptance criteria but defined no tables. Schemas and the
   report rubric/ranking (previously named but never specified) are now
   defined in §7.6 and §10 (`report-ranking-v1`).
10. **Summary dead-end resolved** — summaries are generated for all non-archive
    items; archive items publish without summaries; permanently failed
    summaries stay `summary_pending` with a diagnostics backlog count and
    explicit retry (§9.3). The "configured watch items" ambiguity is gone.
11. **Routes completed** — manual sync, run inspection, and retry endpoints are
    now enumerated (§5.5), resolving the gap where §5 required capabilities the
    route list omitted.
12. **Success measures added** — §2.1 operationalises "improves reading
    triage", and §14 adds a written decision gate.
13. **YouTube adapter documented** — a YouTube channel/transcript adapter was
    missing from earlier drafts; it is now an optional News source (§6.2).
14. **CSP/image conflict resolved** — the baseline renders no remote article
    images (`image_url` is metadata only), keeping the CSP restrictive; the
    stray "retain original branding" sentence (template residue) was removed.
15. **Style** — each normative rule is stated once and cross-referenced
    (`summary_pending` was previously restated in five sections; the watermark
    algorithm twice; the OpenCode exclusion three times). Spelling is
    consistently British in prose; code identifiers are unchanged. Jev, Noul,
    and other terms are defined in a glossary; the unexplained "5,300-source"
    reference was removed.
