/**
 * Moves the farm data of the desktop (Windows) edition into the MySQL database.
 *
 *   npm run import-sqlite -- "C:\Users\<you>\AppData\Roaming\Poultry Farm Manager\data\farm.db"
 *   npm run import-sqlite -- PoultryFarm-20261020-080000-manual.pfmbackup
 *
 * Accepts the desktop database file (close the desktop program first) or one of its .pfmbackup
 * files. ALL records in the MySQL farm database are replaced; a safety backup of them is made
 * first. Add --yes to skip the confirmation question.
 */
import readline from 'node:readline/promises'
import { loadConfig } from '../src/server/config'
import { Databases } from '../src/server/databases'
import { createBackup, inspectBackup, restoreData } from '../src/server/services/backup'
import { audit } from '../src/server/services/audit'

const file = process.argv.slice(2).find((a) => !a.startsWith('--'))
if (!file) {
  console.error('Usage: npm run import-sqlite -- <farm.db or .pfmbackup file> [--yes]')
  process.exit(1)
}
const cfg = loadConfig()
const check = await inspectBackup(file)
if (!check.ok || !check.data) {
  console.error(`This file cannot be imported: ${check.error}`)
  process.exit(1)
}
console.log(`Farm: ${check.farmName ?? '—'} · days recorded: ${check.dayCount} (last: ${check.lastDate ?? '—'}) · schema v${check.schemaVersion}`)
const dbs = await Databases.open(cfg)
try {
  if (!process.argv.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`Replace ALL records in ${dbs.location('farm')} with this data? Type IMPORT to continue: `)
    rl.close()
    if (answer.trim() !== 'IMPORT') {
      console.log('Cancelled; nothing was changed.')
      process.exit(0)
    }
  }
  await dbs.with('farm', async (db) => {
    const safety = await createBackup(db, cfg.backupDir, 'pre_restore')
    if (safety.status !== 'ok') throw new Error(`Safety backup failed: ${safety.message}`)
    console.log(`Safety backup of the current MySQL data: ${safety.path}`)
    await db.withWriteLock(() => restoreData(db, check.data!))
    await audit({ db, user: null, now: () => new Date() }, { action: 'restored_from_backup', entity: 'backup', details: { from: file, safetyBackup: safety.path, importedFrom: 'desktop' } })
  })
  console.log('Import complete. Sign in with the users and passwords from the desktop edition.')
} finally {
  await dbs.close()
}
