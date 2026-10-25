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
5. Open http://localhost:3000 and complete the first-run setup. It creates the first **organization** (your farm business), its first farm and its administrator, who signs in with an email address.

For development, run `npm run dev`. It starts the API server (with reload) and the Vite dev server on http://localhost:5173.

## Organizations, farms and sign-in

The platform hosts many customer **organizations**. Each has its own farms, users, settings and records, and can never
see or change another organization's data: every record carries its organization, every query is limited to the
signed-in user's organization, and MySQL itself rejects a record that points at another organization's data
(composite foreign keys). `tests/tenancy.test.ts` attacks every API method across organizations.

- Everyone signs in with an **email address**, unique on the whole platform.
- Staff can sign themselves up with their organization's code (shown under *Settings*); an administrator approves them.
- The day cycle, cages and hen counts belong to a **farm**; stock, suppliers, customers and the egg store belong to the organization.
- Additional organizations are added by the platform owner in the Super Admin console (below).

## Farms, houses and flocks

- An organization can have several **farms** (up to its plan's limit; *Settings → Farms*). Each farm has its own cages,
  houses, flocks and day cycle; stock, suppliers, customers and users are shared. Users switch farms from the farm name
  in the top bar. Archiving a farm keeps its records.
- **Poultry houses** (sheds) group a farm's cages (*Cage Management*). Optional.
- A **flock** (batch) is tracked as a group, not bird by bird. It has a breed, source, arrival date, birds on arrival
  and a hatch date (or, when unknown, the age on arrival, from which the hatch date is estimated and marked as such).
  It is placed in cages for date ranges; a cage holds one flock at a time. Its birds, eggs, deaths, feed, water and
  treatments are the records of those cages on those dates, so nothing is entered twice.
- **Age:** the hatch date is day 0; weeks are completed weeks (7 days = 1 week). **Production stages** start at an age
  in weeks and can be changed in *Settings* (the starting values are examples to adjust to the breed's guide).
- **Age reminders** (*Flocks → Age reminders*) are the organization's own programme, entered by authorized staff, for
  example from its veterinarian. They show on the dashboard in their week of age and stay overdue until marked done or
  skipped (with a reason). The system never suggests treatments or doses.
- Quantities, meter readings and money are stored as exact decimals (3 places for quantities, 2 for amounts).

## Stores, purchasing and tasks

- **Stores (warehouses):** stock is held per store. Every farm has a main store (the feed and medicine recorded on the
  daily screens come out of it); more stores can be added within the plan's limit (*Stores*). Stock moves between
  stores by **transfer** (a matched pair of movements), and a **stock count** posts the difference from the recorded
  stock as a correction. Stock never goes below zero in any store. Stock is valued at the average purchase cost.
- **Purchase orders** record what was ordered; **goods received notes** are recorded against them (or without one).
  A delivery records delivered, rejected and damaged quantities (rejects need a reason); only what was accepted is added
  to stock, and nothing more than is still outstanding on the order. If *Settings* requires approval, a note waits until
  someone with *Approve goods received notes* approves it (not the person who recorded it, unless an administrator).
  Each form carries a one-time key, so sending it twice records the delivery once.
- Nothing already recorded is changed: a cancelled receipt stays in the history and its stock is taken out by reversing
  movements.
- **Tasks:** one-time or recurring (daily, weekly, monthly), assigned to a person or a team (a role), with priority,
  instructions and "done when" criteria. Assignees start and complete them; task managers create, verify and cancel
  them. Every step is in the task's history; overdue tasks show on the dashboard; *Tasks → Completion report* shows
  on-time and late completion by week or month. Attachments are not supported yet.

## Dashboards, reports and exports

- **Farm dashboard** (*Dashboard*): the farm being worked on. **Organization overview** (*Overview*): every farm side
  by side for 7, 30 or 90 days with totals, egg trend per farm, laying % by farm, stock alerts and expiring batches,
  flock reminders due, recent deliveries and stock movements. Production figures count **closed days only**, and the
  page shows how each figure is calculated (see also `src/shared/overview.ts`): laying % = eggs ÷ bird-days, mortality
  = deaths ÷ hens at the start of the period, feed per bird = feed ÷ bird-days. Totals are worked out again from the
  summed parts, never averaged.
- **Stock movements** (*Stores → Stock movements*): every movement with date, store, item and type filters, 50 per page.
- **CSV downloads** (UTF-8, open in Excel) of the farm comparison, daily production, stock movements, goods received
  and tasks, for users allowed to export, on plans with the export module. Text that a spreadsheet would treat as a
  formula is neutralised.
- The **platform console** shows platform health: version and schema, uptime, database size, backup folder size,
  failed backups, and background job failures since the server started. It never shows customers' farm records.

## Plans, subscriptions and the Super Admin console

Every organization has one subscription to a **plan**. The three plans created by the database upgrade are:

| Plan | Users | Admins | Custom roles | Farms | Stores | Modules |
|---|---|---|---|---|---|---|
| Starter | 5 | 1 | 3 | 1 | 1 | the core farm work only |
| Growth | 15 | 2 | 10 | 3 | 3 | purchasing, egg sales, advanced reports, several farms, Excel exports |
| Enterprise | 50 | 5 | 30 | 10 | 10 | all |

- Limits, modules and plans can be changed in the console, and any limit can be set per customer. Everything is
  checked on the server (`src/server/services/subscriptions.ts`); the screens only hide what the plan does not include.
- **Users** counts active accounts plus sign-ups waiting for approval; deactivated accounts free their seat.
- The state follows the dates: *trial* → *active* → *grace period* (14 days by default) → *expired*. Expired, cancelled and
  suspended subscriptions are **read-only**: records can be viewed and backed up but not changed, and nothing is deleted.
  Lowering a limit below what is in use removes nothing; only adding more is refused.
- Organizations that existed before subscriptions (and the first organization of a new installation) are on Enterprise
  with no end date. New organizations made in the console start on the plan and trial length chosen there.

The **console** is at `/#/platform`. Platform administrators are separate accounts, created on the server only:

```sh
npm run create-super-admin -- ops@serenova.lk "Serenova Operations"   # asks for a password (10+ characters)
npm run create-super-admin -- --list
npm run create-super-admin -- --disable ops@serenova.lk               # signs them out at once
```

It shows organizations, their plan, subscription state and usage, and lets you create organizations, change
subscriptions and suspend or reactivate an organization (suspending signs its users out; records stay). It does
**not** show any organization's farm records. Every console action, including sign-ins, is recorded in
`platform_audit`, and changes require a written reason.

## Moving a farm from the desktop edition

With the desktop program closed, import its database (or one of its `.pfmbackup` files) as an organization:

```sh
npm run import-sqlite -- "C:\Users\<you>\AppData\Roaming\Poultry Farm Manager\data\farm.db" --email admin=owner@farm.lk --email worker=staff@farm.lk
```

- Without `--org`, a new organization is created for the farm. With `--org <code>`, that organization's records are
  replaced (after a safety backup).
- Desktop accounts signed in with a username; give each one an email address with `--email username=address`
  (or type them when asked). Passwords, recovery codes and the full history move over unchanged.
- The import is one transaction: if anything fails, nothing is changed.

**Cut-over checklist (Madawala Farm):** stop entering data in the desktop program → copy its `farm.db` → import it into a
*staging* database first and compare day count, hen counts, stock balances and egg totals with the desktop screens →
import into production → staff sign in with their email addresses. Keep the desktop data file untouched as a fallback.

Rehearsed on 24 October 2026 on a copy of Madawala's desktop data (6 days): row counts in all 26 tables, egg,
mortality, feed and opening-hen totals, stock per item, day status, password hashes, and each day's opening/closing
hens and eggs as calculated by the web edition all matched the desktop data.

## What changed from the desktop edition

| Desktop | Web |
|---|---|
| One farm, one user signed in on one PC | Many organizations and users at once, each with their own session (an HttpOnly, SameSite cookie). Sessions are stored hashed in MySQL and expire after `SESSION_IDLE_HOURS` without activity. A disabled account or a changed role takes effect on the next request. |
| SQLite file, one writer at a time | MySQL. Data-changing requests are serialized with a MySQL named lock, so checks such as "stock never goes negative" and "hens never go negative" cannot race. |
| Print and Save PDF through Windows | **Print** and **PDF** use the browser's print dialog (choose "Save as PDF"). **Excel** downloads directly. Reports are listed under *Recently generated* and can be produced again from there. |
| End-of-day PDF saved automatically | The day still closes with its snapshot; print the end-of-day report from *Reports* when needed. |
| Backups with SQLite's backup API to a local folder | Each organization's records are backed up to `BACKUP_DIR` (verified, compressed), automatically on its schedule and on demand. Its administrators can download them and restore one of their own backups, which replaces only their organization's records. A whole-database backup is also made daily for the platform owner. Before an existing database is upgraded, the server backs it up. |
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
npm run import-sqlite -- <file> [--org <code>] [--email <username>=<address> ...]   # import a desktop farm
npm run reset-password -- --list           # list users of all organizations
npm run reset-password -- <email address>  # set a new password when the recovery code is lost too
npm run create-super-admin -- <email> "<name>"   # a platform administrator for the console at /#/platform
```

## Deployment, recovery and security

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): environments, preparing a server, the staging → approval → production
  workflow, health checks, database upgrades and rollback.
- [docs/RECOVERY.md](docs/RECOVERY.md): what is backed up, encryption, restore drills (`npm run restore-test`),
  restoring one organization or the whole database, recovery objectives.
- [docs/SECURITY.md](docs/SECURITY.md): how sign-in, sessions, authorization, tenant isolation, secrets, backups
  and auditing are handled.
- [CHANGELOG.md](CHANGELOG.md): release history.
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md): the acceptance criteria, how each is verified, and remaining limitations.

## Tests

```sh
npm test         # 145 tests; a temporary MySQL 8.4 server is downloaded once and started automatically
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
scripts/           build, migrate, import-sqlite, reset-password, create-super-admin
tests/             unit and workflow tests (run against MySQL)
resources/manuals/ user manuals (served at /manuals/…)
```
