# Backup and recovery

## What is backed up

| Backup | When | Contains | Kept |
|---|---|---|---|
| Organization backup (automatic) | on each organization's schedule (*Backup* settings, default daily) | that organization's records | its retention setting (default 14) |
| Organization backup (manual) | *Backup → Back up now* | that organization's records | until deleted |
| Whole-database backup | daily | every organization and the platform tables | 14 |
| Pre-migration backup | before a new release upgrades the database | the whole database | until deleted |
| Pre-restore backup | before an organization restores a backup | that organization's records | until deleted |

All backups are written to `BACKUP_DIR` (default `data/backups`), compressed, and **checked
after writing**: a backup is only kept when it reads back correctly. With `BACKUP_ENCRYPTION_KEY`
set (required in production), files are encrypted with AES-256-GCM; any change to a file is detected.
**Keep a copy of the key apart from the server** — without it the backups cannot be read.

Copy `BACKUP_DIR` off the server every day (another region or provider). Backups on the same disk
do not protect against losing the server.

### Recovery objectives (defaults)

- **Recovery point**: at most 24 hours of data (daily backups; shorten the organization backup
  interval for less).
- **Recovery time**: under one hour for a database of a few GB (restore + start + checks).

## Restore drills

A backup counts as reliable only once it has been restored. With `RESTORE_TEST_DB_NAME` set to a
separate, empty database (its name must contain "restore"), the server restores the newest
whole-database backup into it every week and checks every table's row count and every link between
records. Run one at any time:

```sh
npm run restore-test                     # newest whole-database backup
npm run restore-test -- <backup file>    # a particular file
```

Results are shown in the platform console (Overview → Platform health, and Releases → Restore tests).
The drill never writes to the farm database except to record its result.

## Restoring one organization

An organization administrator (*Backup → Restore*) can restore one of **their own organization's**
backups. It replaces only that organization's records; a safety backup of the current records is
written first, and everyone in the organization is signed out. It cannot be used on another
organization's data or on the whole database.

## Restoring the whole database (platform, privileged)

Only for a disaster (database lost or corrupted). It replaces every organization's data.

1. **Decide and record**: who authorized it, which backup, why, and the expected data loss
   (everything after the backup's time).
2. **Test first**: `npm run restore-test -- <file>` must pass for that file.
3. Stop the service: `sudo systemctl stop serenova`.
4. Back up whatever is in the database now (even if damaged):
   `mysqldump --single-transaction serenova > /opt/serenova/shared/data/before-recovery.sql`.
5. Restore (from the release folder on the server; the database name must be typed exactly):
   ```sh
   cd /opt/serenova/current
   npm run restore-database -- <backup file> --confirm serenova --reason "Disk failure, authorized by <name>"
   ```
   It refuses a backup without a passed restore drill, writes a backup of the current database
   first, restores in one transaction (if anything fails, nothing is changed) and records the
   restore in the platform audit log.
6. Start the service and check `/readyz`; sign in to the console and one organization.
7. Record the recovery (time, backup used, checks done) in your incident log.

## Undoing a database upgrade

Databases are never downgraded automatically. If a release's upgrade must be undone:

1. Switch the code back to the previous release (`docs/DEPLOYMENT.md`, Rolling back).
2. Restore the **pre-migration backup** written just before the upgrade (named
   `PoultryFarm-all-…-pre_migration.pfmbackup`) as in *Restoring the whole database*. Records
   entered after the upgrade are lost, so only do this when the upgrade damaged data.
