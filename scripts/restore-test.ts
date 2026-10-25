/**
 * Restore drill: restores the newest whole-database backup (or the file given) into the separate
 * restore-test database (RESTORE_TEST_DB_NAME), checks every table's row count and every link, and
 * records the result (shown in the platform console). The farm database is never changed.
 *
 *   npm run restore-test
 *   npm run restore-test -- data/backups/PoultryFarm-all-20261024-020000-auto.pfmbackup
 */
import { loadConfig } from '../src/server/config'
import { Databases } from '../src/server/databases'
import { runRestoreTest } from '../src/server/services/restore-test'

const cfg = loadConfig()
const dbs = await Databases.open(cfg)
try {
  const r = await dbs.with('farm', (db) => runRestoreTest(db, cfg, process.argv[2]))
  console.log(`${r.status === 'ok' ? 'PASSED' : 'FAILED'}: ${r.backupFile} → ${r.targetDatabase}`)
  console.log(`${r.tablesChecked} tables, ${r.rowsChecked} rows checked in ${(r.durationMs / 1000).toFixed(1)} s`)
  for (const p of r.problems) console.log(' - ' + p)
  if (r.status !== 'ok') process.exitCode = 1
} catch (e) {
  console.error('ERROR: ' + (e as Error).message)
  process.exitCode = 1
} finally {
  await dbs.close()
}
