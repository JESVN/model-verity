# Security Policy

## Reporting a Vulnerability

Please do **not** open a public issue for a suspected vulnerability.

Send details privately via private vulnerability reporting (GitHub
"Security" → "Report a vulnerability") for this repository, or contact the
maintainer through the repository's owner profile.

When reporting, include:

- Affected module / endpoint and the surrounding call path.
- Steps to reproduce, including the smallest failing input if possible.
- Expected versus observed behavior.
- Whether the issue has any data, budget, or cost implications.

## Scope

The project runs as a local CLI and a self-hosted server. Hard security
boundaries are documented in `AGENTS.md` ("安全与生产操作"):

- No real provider endpoints are called by tests, builds, or smoke checks.
- Temporary credentials live only in memory and are tied to a run/role;
  long-lived keys are encrypted at rest.
- Outbound requests refuse private / loopback / link-local / CGNAT /
  reserved addresses and redirects by default (SSRF protection). A local
  mock is the only allowed override and must be enabled explicitly.
- Deleting production data, migration, restore, or lowering a control
  requires: no active tasks, a full backup, and an impact statement.

## Versioning / Disclosure

Reported issues are acknowledged promptly. Fixes follow the release and
review process described in `AGENTS.md`. npm releases are approved
separately and are never performed automatically.