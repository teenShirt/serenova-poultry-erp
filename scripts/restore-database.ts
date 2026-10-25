/**
 * Disaster recovery: replaces the WHOLE database (every organization) with a whole-database
 * backup. Privileged and destructive — see docs/RECOVERY.md first. Run on the server, with the
 * service stopped:
 *
 *   npm run restore-database -- <backup file> --confirm <database name> --reason "<why, who authorized>"
 *
 * Refuses unless the backup passes a restore drill (npm run restore-test -- <file>) first, the
 * database name is typed exactly, and a reason is given. A backup of the current database is
 * written first; the restore runs in one transaction (all or nothing) and is recorded in the
 * platform audit log.
 */
import { loadConfig } from '../src/server/config'
import { Databases } from '../src/server/databases'
import { createBackup, readBackup, restoreDatabase } from '../src/server/services/backup'
import { platformAudit } from '../src/server/services/platform'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const file = args.find((a, i) => !a.startsWith('--') && !['--confirm', '--reason'].includes(args[i - 1] ?? ''))
const cfg = loadConfig()

if (!file || arg('--confirm') !== cfg.db.database || (arg('--reason')?.trim().length ?? 0) < 10) {
  console.error('Usage: npm run restore-database -- <backup file> --confirm <database name> --reason "<why, who authorized>"')
  console.error(`The database name must be typed exactly (${cfg.db.database}); the reason must be at least 10 characters.`)
  process.exit(2)
}

const dbs = await Databases.open(cfg)
try {
  await dbs.with('farm', async (db) => {
    const passed = await db.prepare("SELECT 1 AS x FROM restore_tests WHERE status = 'ok' AND backup_file = ? ORDER BY id DESC LIMIT 1").get(path.resolve(file))
    if (!passed) throw new Error(`This backup has no passed restore drill. Run first: npm run restore-test -- ${file}`)
    const data = readBackup(file)
    if (data.scope !== 'database') throw new Error('Not a whole-database backup')
    const safety = await createBackup(db, cfg.backupDir, 'pre_restore', { orgId: null })
    if (safety.status !== 'ok') throw new Error(`Could not back up the current database first: ${safety.message}`)
    console.log(`Current database backed up to ${safety.path}`)
    await restoreDatabase(db, data)
    await platformAudit(db, null, 'restore_whole_database', null, {
      file: path.basename(file),
      backupCreatedAt: data.createdAt,
      safetyBackup: safety.path,
      reason: arg('--reason')
    })
    console.log(`Restored ${file} (made ${data.createdAt}). Start the service and check /readyz.`)
  })
} catch (e) {
  console.error('ERROR: ' + (e as Error).message)
  process.exitCode = 1
} finally {
  await dbs.close()
}
