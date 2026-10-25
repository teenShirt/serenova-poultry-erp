# Changelog

Release history of Serenova Poultry ERP. Each version is deployed from `main` by the
deployment workflow (see `docs/DEPLOYMENT.md`). The newest version listed here is the latest
approved release; the platform console shows these notes.

## [2.1.0] - 2026-10-24

Reliability and delivery.

- Separate development, staging and production settings (`APP_ENV`); a production server refuses
  to start without HTTPS cookies, a setup key, its own database account and backup encryption.
- Health checks: `/healthz` (the server answers) and `/readyz` (the database answers and has this
  release's schema).
- Sign-in, sign-up, password reset and first-run setup are rate limited per address.
- Backups can be encrypted at rest (AES-256-GCM, `BACKUP_ENCRYPTION_KEY`).
- Restore drill: the newest whole-database backup is restored into a separate database, checked
  table by table and link by link, weekly and on demand (`npm run restore-test`).
- Release history: each start records version, commit, environment and database upgrade;
  the platform console shows it with these notes, restore tests and security events.
- Deployment workflow: staging deploy and smoke tests, then production after approval, with
  health checks and rollback of the code (never of the database).
- Exports and backup downloads are recorded in the activity history.

## [2.0.0] - 2026-10-24

The web edition of Poultry Farm Manager, grown into a multi-organization ERP.

- Phase 6: organization overview of all farms, stock movement history, CSV exports, platform health.
- Phase 5: stores and transfers, stock counts, purchase orders, goods received notes with approval, tasks.
- Phase 4: farms, poultry houses, flocks with hen age, production stages and age reminders; exact decimals.
- Phase 3: plans and subscriptions enforced on the server; Super Admin console.
- Phase 2: organization roles and permissions; new dashboard.
- Phase 1: organizations and farms with tenant isolation; email sign-in.
- Node.js, React and MySQL edition of the desktop Poultry Farm Manager; desktop data can be imported.
