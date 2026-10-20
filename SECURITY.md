# Security Policy

## Supported versions

Security fixes are currently considered for the latest `v1.x` release and the
default branch.

This project is a personal application and public technical baseline. It does
not promise commercial support or a guaranteed response time.

## Reporting a vulnerability

Please do **not** report suspected vulnerabilities in a public GitHub issue.

When GitHub private vulnerability reporting is enabled, use the repository's
**Report a vulnerability** workflow under the Security tab. If that option is
not available, contact the repository owner through the private contact method
listed in the repository profile.

Please include:

- a clear description of the issue and its security impact;
- affected files, endpoints, versions, or configurations;
- reliable reproduction steps or a minimal proof of concept;
- any prerequisites or required access; and
- a suggested mitigation, if known.

Please avoid including real credentials, personal data, production database
contents, or other sensitive information in the report.

## Response process

Reports will be acknowledged when practical, investigated, and fixed or
documented as appropriate. Credit will be given to reporters who want it,
unless they request anonymity.

## Deployment note

Operators must keep provider credentials, SMTP credentials, authentication
configuration, SQLite databases, backups, and tunnel credentials outside Git
and out of browser-delivered code. See [DEPLOYMENT.md](DEPLOYMENT.md).
