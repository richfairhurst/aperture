# Aperture Deployment Guide

This is a sanitized deployment checklist for the Bun/SQLite v1 application. It
contains no hostnames, usernames, tokens, or production secret values.

## Target architecture

```text
Cloudflare HTTPS edge
        │
        ▼
Cloudflare Tunnel or reverse proxy
        │
        ▼
Bun application on a Linux VPS
        │
        ├── loopback application port
        ├── SQLite database on persistent storage
        └── environment-provided secrets
```

The public edge should be the only route to the application. The application
port should not be exposed directly to the public internet, and the firewall
should default to deny unsolicited inbound traffic.

## Deployment prerequisites

- Linux VPS with persistent storage
- Bun installed at the version supported by the repository
- SSH access through a private management network where possible
- Cloudflare Tunnel or an equivalent HTTPS reverse proxy
- A supervised application process, preferably a systemd service
- Production `.env` stored only on the server with restrictive permissions
- A tested SQLite backup location

## Application update checklist

1. Run `bun run check` locally.
2. Back up the production SQLite database before changing application files.
3. Transfer the repository application files to the server.
4. Do not overwrite the server `.env`, `data/`, or any server-only state.
5. Run `bun install --frozen-lockfile` on the server.
6. Start or restart the supervised Bun service.
7. Allow startup to apply pending migrations.
8. Check the local health endpoint.
9. Check the public HTTPS health endpoint through the edge layer.
10. Review application and tunnel logs for startup or migration failures.

## Secrets

Production secrets must be supplied through the server environment or an
equivalent secret manager. They must not be copied into Git, deployment logs,
command history, SQLite, or browser responses.

At minimum, protect:

- Readwise and Jev credentials
- Summary-provider credentials
- SMTP credentials
- Authentication configuration
- Any optional provider credentials

## SQLite operations

- Back up before deployments and migrations.
- Keep the database on persistent storage.
- Do not copy production data into the public repository.
- Verify migration completion after startup.
- Test restoring a backup periodically.

## Cloudflare Tunnel

The tunnel should route the public hostname to the application’s loopback
service port and return a deliberate 404 for unmatched hostnames. Keep the
tunnel token outside the repository and restrict its file permissions.

## Rollback

If the health check fails:

1. Stop the new application process.
2. Restore the previous application files.
3. Restore the database backup only if the migration or application changed
   the schema incompatibly.
4. Restart the supervised service.
5. Verify local and public health endpoints.
6. Preserve logs before investigating the failed release.
