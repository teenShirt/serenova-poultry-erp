# Acceptance report — release 2.2.0

Checked on 25 October 2026 against the acceptance criteria of the Serenova Poultry ERP brief.
Automated tests: **148 passing** (`npm test`, MySQL 8.4), plus typecheck, lint, formatting, build,
dependency audit and a staging-style start with smoke tests on every CI run.

**Met** = verified by automated tests (or the rehearsal named). **Partly** = works, with the limits stated.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Existing Madawala workflows continue to work | Met | `workflow.test.ts` (start day, records, checks, close, amend), `reports.test.ts`; Madawala's desktop data imported and every daily figure recalculated identically (rehearsal below) |
| 2 | Existing customer data remains intact | Met | `migration-v5.test.ts` (an installation from before organizations upgraded to the current schema, every record kept), `acceptance.test.ts` (its stock and deliveries in the main store, exact decimals); a full backup is written before every upgrade; Madawala rehearsal |
| 3 | A new organization can be created and onboarded | Met | `acceptance.test.ts` (console creates it on a trial plan → its administrator signs in, adds a cage, starts a day), `subscriptions.test.ts` |
| 4 | Each organization has its own users, roles, locations and records | Met | `tenancy.test.ts`; composite foreign keys make MySQL itself refuse cross-organization links (`migration-v5.test.ts`) |
| 5 | Cross-tenant access attempts are rejected by the backend | Met | `tenancy.test.ts`: every API method is either attacked with another organization's ids (all refused, records unchanged) or reads that are shown never to return another organization's data; a test fails if a new method is added without being considered |
| 6 | Subscription limits are enforced consistently | Met | `subscriptions.test.ts` (users incl. pending sign-ups, administrators, roles, modules, read-only on expiry), `flocks.test.ts` (farms), `stores.test.ts` (stores) |
| 7 | Organization Admins can manage permitted employees and roles | Met | `accounts.test.ts` (sign-ups approved or rejected, lockout, recovery codes), `erp.test.ts` (custom roles, nobody can grant permissions they do not hold or change a more powerful account, the administrator role cannot be changed or archived) |
| 8 | Deactivated users cannot continue accessing protected resources | Met | `tenancy.test.ts` (the next request of a disabled account has no user), `accounts.test.ts` (a suspended organization cannot sign in), `subscriptions.test.ts` (suspending an organization ends its sessions) |
| 9 | CRUD permissions are enforced for each module | Met | `acceptance.test.ts`: a role with no permissions is refused **every** request that needs one (all 70+ in `PERMISSION_FOR_METHOD`), also through the API; `erp.test.ts` for cage-level duties |
| 10 | Hen age and flock calculations are correct | Met | `flocks.test.ts` (age rule: hatch day = day 0, completed weeks; estimated hatch date; stages; flock figures = its cages' records while placed) |
| 11 | Feeding and medical schedules produce the correct reminders | Met | `schedules.test.ts` (planned feeding times: on time / late / missed / due / later, missed feedings on the dashboard; egg withdrawal after a treatment for exactly the medicine's period and only the treated cage, none when the medicine has no period); age reminders: `flocks.test.ts`; recurring feeding and vaccination tasks: `stores.test.ts` |
| 12 | Weekly tasks can be assigned, tracked and reported | Met | `stores.test.ts` (people and teams, start / complete with criteria / verify / cancel, history, weekly report, recurring occurrences made once). Attachments not supported yet |
| 13 | GRN posting and inventory movements preserve stock accuracy | Met | `stores.test.ts` (partial receipts, rejects, no over-receipt, posted once even if sent twice, approval posts exactly once, cancellation reverses), `erp.test.ts` (stock added exactly once per line; a delivery whose stock was used cannot be cancelled), `backup.test.ts` (concurrent requests cannot spend the same stock) |
| 14 | Warehouse transfers and adjustments are auditable | Met | `acceptance.test.ts` (transfers and counts in the activity history with who and what; every movement keeps its recorder), adjustments need a reason and permission (`workflow.test.ts`) |
| 15 | Dashboard totals reconcile with source records | Met | `acceptance.test.ts` (overview, daily series, day overview and store balances equal sums computed directly from the stored records), `overview.test.ts` (closed days only, rates recomputed from parts), `erp.test.ts` (daily series and the farm flow agree with the records); Madawala rehearsal |
| 16 | Backup integrity and restore procedures are tested | Met | `backup.test.ts` (backups verified after writing; organization and whole-database restores; restoring one organization never changes another; files that are not intact refused), `reliability.test.ts` (encryption and tamper detection, restore drill into a separate database checked table by table); weekly drills in production |
| 17 | CI/CD can deploy to staging and validate the release | Partly | CI starts every production build in staging mode on an empty database and runs the smoke tests; the Deploy workflow builds each tested release. Deploying to a real staging server waits for the servers (docs/DEPLOYMENT.md) |
| 18 | Unauthorized users cannot execute privileged actions through direct API calls | Met | `acceptance.test.ts` (#9), `tenancy.test.ts`, `subscriptions.test.ts` (console requests need a platform administrator; organization administrators cannot use it), `reliability.test.ts` (rate limit on sign-in) |

## Madawala cut-over rehearsal (release 2.1.0)

On 25 October 2026 a copy of Madawala's desktop database (6 days, 13–23 October 2026, 2 accounts)
was imported with `npm run import-sqlite` into a throw-away MySQL database and compared with the
desktop file. **Every check matched**: row counts of all 25 desktop tables, egg / flock / feed / water
/ opening-hen totals, stock per item, day status, password hashes (desktop passwords keep working),
each day's opening and closing hens and eggs as recalculated by the web edition, the organization
overview (closed days, eggs, deaths), all stock in the farm's main store, and every link between
records. The copy and the rehearsal database were deleted afterwards.

## Remaining limitations

- Task attachments are not supported (no file uploads apart from organization backups).
- Stock statuses *reserved* and *quarantined* are not separate yet; stock counts on screen are by item
  (the server supports batches).
- No real staging or production server exists yet; deployments run once they are configured.
- Sinhala texts of the newer screens need a review by a native speaker.
- Single server: sign-in rate limits and the background-job failure list are kept in memory (per process).
