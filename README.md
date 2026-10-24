# Poultry Farm Manager — web edition

The Poultry Farm Manager desktop application, rebuilt as a web application with a **MySQL** database.
Everyone on the farm can use it from a browser (PC, tablet or phone) at the same time. The screens,
English and Sinhala languages, daily workflow, calculations and checks are the same as in the desktop edition.

| Layer | Technology |
|---|---|
| Browser app | React 19, React Router, Recharts (the desktop screens, unchanged apart from the items below) |
| Server | Node.js 20+, Express 5, TypeScript; all business rules from the desktop edition |
| Database | MySQL 8.0.19+ (InnoDB, utf8mb4) via `mysql2` |

## Quick start

1. Install **Node.js 20+** and **MySQL 8**.
2. Create a MySQL account for the app:
   ```sql
   CREATE USER 'poultry'@'localhost' IDENTIFIED BY 'a-strong-password';
   GRANT ALL PRIVILEGES ON poultry_farm.* TO 'poultry'@'localhost';
   GRANT ALL PRIVILEGES ON poultry_farm_demo.* TO 'poultry'@'localhost';
   ```
   The server creates both databases and all their tables on its first start.
3. Copy `.env.example` to `.env` and set `DB_PASSWORD` (and `SETUP_KEY` if the site is reachable from the internet).
4. Install, build and start the app:
   ```sh
   npm install
   npm run build
   npm start
   ```
5. Open http://localhost:3000 and complete the first-run setup, as in the desktop edition.

For development, run `npm run dev`. It starts the API server (with reload) and the Vite dev server on http://localhost:5173.

## Moving data from the desktop edition

Either of these replaces all records in the MySQL farm database. A safety backup of the current data is made first.

- **In the browser:** sign in as an administrator, go to **Backup & restore → Upload backup file…**, and choose a
  `.pfmbackup` file made by the desktop edition.
- **From the command line**, with the desktop program closed:
  ```sh
  npm run import-sqlite -- "C:\Users\<you>\AppData\Roaming\Poultry Farm Manager\data\farm.db"
  ```

Users, passwords, recovery codes and the full history move over unchanged. The MySQL schema keeps the same tables and
columns as the desktop schema (migrations 1–3), so desktop backups map onto it column for column.

## What changed from the desktop edition

| Desktop | Web |
|---|---|
| One user signed in on one PC | Many users at once, each with their own session (an HttpOnly, SameSite cookie). Sessions are stored hashed in MySQL and expire after `SESSION_IDLE_HOURS` without activity. A disabled account or a changed role takes effect on the next request. |
| SQLite file, one writer at a time | MySQL. Data-changing requests are serialized with a MySQL named lock, so checks such as "stock never goes negative" and "hens never go negative" cannot race. |
| Print and Save PDF through Windows | **Print** and **PDF** use the browser's print dialog (choose "Save as PDF"). **Excel** downloads directly. Reports are listed under *Recently generated* and can be produced again from there. |
| End-of-day PDF saved automatically | The day still closes with its snapshot; print the end-of-day report from *Reports* when needed. |
| Backups with SQLite's backup API to a local folder | The server writes verified, compressed snapshots to `BACKUP_DIR`, automatically on the configured schedule and on demand. Administrators can download them, and restore by uploading a file from this web edition or from the desktop edition. |
| In-app updater | Removed: update the server with `git pull && npm install && npm run build` and restart. Database changes are applied automatically. |
| Demonstration data in `demo.db` | A separate MySQL database, `<DB_NAME>_demo`, per browser session, so one visitor exploring the demo does not affect anyone else. |
| Language switch saved for the PC | Before sign-in the language is remembered per browser. After sign-in it is the farm setting, as before. |

## Security notes

- Every API request is checked as before: allow-listed method, zod-validated input, signed-in user, duties and assigned cages,
  and admin-only actions.
- Requests must carry an `X-Requested-With: pfm` header. Together with SameSite cookies, this protects against
  cross-site request forgery. Pages are served with a strict Content-Security-Policy.
- Passwords and recovery codes are hashed with scrypt, and accounts lock for 15 minutes after 5 wrong attempts.
- Only administrators can download backups, because a backup contains every record, including password hashes.
- On the internet, run the app behind HTTPS (for example nginx or Caddy). Set `COOKIE_SECURE=true`, set `TRUST_PROXY=1`,
  and set a `SETUP_KEY` before the first start.

## Administration commands

```sh
npm run migrate                       # create/upgrade the databases and print the schema version
npm run import-sqlite -- <file>       # import a desktop farm.db or .pfmbackup
npm run reset-password -- --list      # list users
npm run reset-password -- <username>  # set a new password when the recovery code is lost too
```

## Tests

```sh
npm test         # 84 tests; a temporary MySQL 8.4 server is downloaded once and started automatically
npm run typecheck
npm run lint     # includes checks that every database call is awaited
```

To use an existing MySQL server for the tests instead, set `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER` and
`TEST_DB_PASSWORD`. Each test creates and removes its own database.

## Branches and releases

| Branch | Purpose |
|---|---|
| `test` | All development. Every push runs CI (typecheck, lint, tests on MySQL 8.4, build, dependency audit). |
| `main` | Stable code only. It receives changes from `test` once CI has passed on `test`; never commit to it directly. |

Releasing a change: push to `test` → CI passes → merge `test` into `main` (fast-forward) → CI runs again on `main`.
Production deployments will be made from `main` only (see the roadmap: staging and approved deployments come later).

## Project layout

```
src/server/        Express server, API handlers, sessions, services (business rules), MySQL schema
src/server/db/     connection.ts (async MySQL session with nested transactions), migrations.ts
src/client/        React app (the desktop screens)
src/shared/        API contract, types, calculations, English/Sinhala translations
scripts/           build, migrate, import-sqlite, reset-password
tests/             unit and workflow tests (run against MySQL)
resources/manuals/ user manuals (served at /manuals/…)
```
