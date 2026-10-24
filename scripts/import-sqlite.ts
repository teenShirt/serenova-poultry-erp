/**
 * Moves a farm from the desktop (Windows) edition into the web edition, as its own organization.
 *
 *   npm run import-sqlite -- <farm.db or .pfmbackup file> [--org <code>] [--email <username>=<address> ...] [--yes]
 *
 * - The desktop database file (close the desktop program first) or one of its .pfmbackup files.
 * - Without --org, a new organization (with one farm) is created for the imported data.
 *   With --org, ALL records of that existing organization are replaced (a safety backup is made first).
 * - Desktop accounts sign in with a username; the web edition signs in with an email address.
 *   Give each account one with --email, or type them when asked. Accounts without one cannot sign
 *   in until an administrator adds it.
 */
import readline from 'node:readline/promises'
import { loadConfig } from '../src/server/config'
import { Databases } from '../src/server/databases'
import { createBackup, inspectBackup, isDesktopBackup, restoreOrganization } from '../src/server/services/backup'
import { audit } from '../src/server/services/audit'
import { normalizeEmail } from '../src/server/services/auth'

const args = process.argv.slice(2)
const flag = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []))
const file = args.find((a, i) => !a.startsWith('--') && !['--org', '--email'].includes(args[i - 1]))
if (!file) {
  console.error('Usage: npm run import-sqlite -- <farm.db or .pfmbackup file> [--org <code>] [--email <username>=<address> ...] [--yes]')
  process.exit(1)
}
const cfg = loadConfig()
const check = await inspectBackup(file)
if (!check.ok || !check.data) {
  console.error(`This file cannot be imported: ${check.error}`)
  process.exit(1)
}
if (!isDesktopBackup(check.data)) {
  console.error('This is a backup from the web edition: restore it from Backup & restore in the browser instead.')
  process.exit(1)
}
console.log(`Farm: ${check.farmName ?? '—'} · days recorded: ${check.dayCount} (last: ${check.lastDate ?? '—'}) · desktop schema v${check.schemaVersion}`)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const yes = args.includes('--yes')
const emails: Record<string, string> = {}
for (const pair of flag('--email')) {
  const [u, e] = pair.split('=')
  if (u && e) emails[u] = normalizeEmail(e)
}
const users = check.data.tables['users']
const ui = users.columns.indexOf('username')
for (const row of users.rows) {
  const username = String(row[ui])
  if (emails[username] || yes) continue
  const e = (await rl.question(`Email address for desktop user "${username}" (Enter to skip): `)).trim()
  if (e) emails[username] = normalizeEmail(e)
}

const dbs = await Databases.open(cfg)
try {
  const orgCode = flag('--org')[0]
  await dbs.with('farm', async (db) => {
    // Creating the organization and loading its records is one transaction: all or nothing.
    await db.withWriteLock(() =>
      db.transaction(async () => {
        let orgId: number
        if (orgCode) {
          const org = (await db.prepare('SELECT id, name FROM organizations WHERE code = ?').get(orgCode)) as { id: number; name: string } | undefined
          if (!org) throw new Error(`No organization with code ${orgCode}`)
          if (!yes) {
            const answer = await rl.question(`Replace ALL records of "${org.name}" (${orgCode}) with this data? Type IMPORT to continue: `)
            if (answer.trim() !== 'IMPORT') throw new Error('Cancelled; nothing was changed.')
          }
          const safety = await createBackup(db, cfg.backupDir, 'pre_restore', { orgId: org.id })
          if (safety.status !== 'ok') throw new Error(`Safety backup failed: ${safety.message}`)
          console.log(`Safety backup of ${orgCode}: ${safety.path}`)
          orgId = org.id
        } else {
          const name = check.farmName ?? 'Imported farm'
          let code =
            name
              .toLowerCase()
              .normalize('NFKD')
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 36) || 'farm'
          for (let n = 2; await db.prepare('SELECT 1 AS x FROM organizations WHERE code = ?').get(code); n++) code = `${code.replace(/-\d+$/, '')}-${n}`
          const at = new Date().toISOString()
          orgId = (await db.prepare('INSERT INTO organizations (code, name, created_at) VALUES (?, ?, ?)').run(code, name, at)).lastInsertRowid
          await db.prepare('INSERT INTO farms (organization_id, code, name, created_at) VALUES (?, ?, ?, ?)').run(orgId, 'main', name, at)
          console.log(`New organization "${name}" (code: ${code})`)
        }
        for (const e of Object.values(emails)) {
          const taken = await db.prepare('SELECT 1 AS x FROM users WHERE email = ? AND organization_id <> ?').get(e, orgId)
          if (taken) throw new Error(`${e} is already used by an account of another organization`)
        }
        await restoreOrganization(db, orgId, check.data!, { emails })
        await audit(
          { db, org: orgId, user: null, now: () => new Date() },
          { action: 'restored_from_backup', entity: 'backup', details: { from: file, importedFrom: 'desktop' } }
        )
        const counts = (await db
          .prepare(
            'SELECT (SELECT COUNT(*) FROM farm_days WHERE organization_id = ?) AS days, (SELECT COUNT(*) FROM users WHERE organization_id = ?) AS users, (SELECT COUNT(*) FROM users WHERE organization_id = ? AND email IS NULL) AS noEmail'
          )
          .get(orgId, orgId, orgId)) as { days: number; users: number; noEmail: number }
        console.log(`Imported: ${counts.days} days, ${counts.users} accounts.`)
        if (counts.noEmail) console.log(`${counts.noEmail} account(s) have no email address yet: an administrator can add one under Settings → Users.`)
        console.log('Each account keeps its desktop password and signs in with its email address.')
      })()
    )
  })
} catch (e) {
  console.error('ERROR: ' + (e as Error).message)
  process.exitCode = 1
} finally {
  rl.close()
  await dbs.close()
}
