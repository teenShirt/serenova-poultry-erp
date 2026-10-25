# Security

| Area | How it is handled | Where |
|---|---|---|
| Passwords and recovery codes | scrypt hashes; never logged; recovery codes shown once | `src/server/services/auth.ts` |
| Sign-in protection | account locks for 15 minutes after 5 wrong passwords; sign-in, sign-up, password reset and first-run setup limited per address (`AUTH_REQUESTS_PER_MINUTE`, default 10) | `auth.ts`, `rate-limit.ts` |
| Sessions | random 256-bit token in an HttpOnly, SameSite=Lax cookie (Secure in production); only its SHA-256 is stored; idle expiry; a new token on every sign-in and sign-out; disabling a user or suspending an organization ends their sessions | `sessions.ts` |
| Request forgery | every API call must carry `X-Requested-With: pfm` (not sendable cross-site without permission) | `index.ts` |
| Authorization | every request: signed-in user, permission of their role, assigned cages, subscription state and modules — checked on the server | `api.ts`, `permissions.ts` |
| Tenant isolation | every record carries its organization; every query filters by it; composite foreign keys stop records pointing into another organization; every API method is attacked across organizations in `tests/tenancy.test.ts` | |
| Input | every API input validated with zod (unknown fields dropped, wrong types refused); SQL only through parameters | `schemas.ts` |
| Output | React escapes everything; strict Content-Security-Policy; reports rendered with escaping; CSV cells that look like formulas are neutralised | `index.ts`, `reports/` |
| Transport | HTTPS in staging and production (`COOKIE_SECURE=true` adds Secure cookies and HSTS) | `index.ts` |
| Secrets | only in environment variables / `.env` (never committed; production refuses to start without the required ones) | `config.ts` |
| Database account | the application's own account with rights on its database only (production refuses `root`) | `docs/DEPLOYMENT.md` |
| Backups | verified after writing, encrypted at rest in production, downloadable only by the organization's backup administrators (their own organization's files only); restore drills weekly | `backup.ts`, `docs/RECOVERY.md` |
| Super Admin access | separate accounts created on the server only; the console never shows farm records; every console action recorded in `platform_audit` | `platform.ts` |
| Audit | sign-ins and failures, account and role changes, stock adjustments and counts, GRN approval and cancellation, exports, backup downloads and restores, subscription changes, and each release started | `audit_log`, `platform_audit`, `deployments` |
| Monitoring | platform console: failed sign-ins and lockouts (24 h), rate-limit refusals, failed backups, background job failures, restore drill results | |
| Dependencies | `npm audit` (high and critical) on every CI run | `.github/workflows/ci.yml` |
| Attachments | not supported yet (no uploads apart from organization backups, which are size-limited and verified before use) | |

Report a vulnerability privately to Serenova Tech rather than in a public issue.
