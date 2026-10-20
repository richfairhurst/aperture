# Contributing to Aperture

Thanks for taking an interest in the project.

## Before you start

Please read:

- [README.md](README.md) for the project overview;
- [SPEC.md](SPEC.md) for product and technical contracts; and
- [SECURITY.md](SECURITY.md) for vulnerability reporting.

Do not include production credentials, SQLite databases, provider content,
personal data, or generated Playwright artifacts in a contribution.

## Local setup

Requirements: Bun `1.3.11`.

```bash
cp .env.example .env
bun install --frozen-lockfile
```

Provider credentials are not required for the automated test suites. Add only
the credentials needed for a local integration or manual smoke test.

## Checks

Run the complete verification suite before submitting a change:

```bash
bun run check
```

This runs TypeScript validation, Prettier, Vitest, and Bun/native SQLite tests.

If you only changed documentation, formatting still needs to pass:

```bash
bun run format:check
```

## Pull requests

- Keep changes focused and explain the user or security problem being solved.
- Add or update tests for behavioural changes.
- Update public documentation when configuration or behaviour changes.
- Do not commit `.env`, SQLite files, logs, or generated artifacts.
- Keep commits small enough to review and include clear context in the pull
  request description.

The repository maintainer may revise or decline changes that conflict with the
public specification or the project's personal/single-user scope.
