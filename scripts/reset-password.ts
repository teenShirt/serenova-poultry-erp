/**
 * Support tool: sets a new password for a user who has lost both their password and recovery code.
 *
 *   npm run reset-password -- --list
 *   npm run reset-password -- <email address>   (asks for the new password)
 *
 * It also unlocks the account, issues a new recovery code (shown once), signs the user out
 * everywhere and records the reset in the organization's audit history.
 */
import readline from 'node:readline/promises'
import { loadConfig } from '../src/server/config'
import { Databases } from '../src/server/databases'
import { generateRecoveryCode, hashPassword, normalizeRecoveryCode } from '../src/server/services/auth'
import { audit } from '../src/server/services/audit'

const dbs = await Databases.open(loadConfig())
try {
  await dbs.with('farm', async (db) => {
    const users = (await db
      .prepare(
        `SELECT u.id, u.organization_id, o.code AS org, u.username, u.email, u.display_name, u.role, u.active
         FROM users u JOIN organizations o ON o.id = u.organization_id ORDER BY o.code, u.username`
      )
      .all()) as {
      id: number
      organization_id: number
      org: string
      username: string
      email: string | null
      display_name: string
      role: string
      active: number
    }[]
    const email = process.argv.slice(2).find((a) => !a.startsWith('--'))
    if (process.argv.includes('--list') || !email) {
      for (const u of users) {
        const login = u.email ?? `(no email; username ${u.username})`
        console.log(`${u.org.padEnd(20)} ${login.padEnd(40)} ${u.display_name} (${u.role}${u.active ? '' : ', disabled'})`)
      }
      if (!email) console.log('\nUsage: npm run reset-password -- <email address>')
      return
    }
    const user = users.find((u) => u.email === email.trim().toLowerCase())
    if (!user) throw new Error(`No account with the email address ${email}`)
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const password = (await rl.question(`New password for ${user.email} (at least 6 characters): `)).trim()
    rl.close()
    if (password.length < 6) throw new Error('The password must have at least 6 characters.')
    const code = generateRecoveryCode()
    await db.transaction(async () => {
      await db
        .prepare('UPDATE users SET password_hash = ?, recovery_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
        .run(hashPassword(password), hashPassword(normalizeRecoveryCode(code)), user.id)
      await db.prepare('DELETE FROM sessions WHERE user_id = ? AND organization_id = ?').run(user.id, user.organization_id)
      await audit(
        { db, org: user.organization_id, user: null, now: () => new Date() },
        { action: 'support_password_reset', entity: 'user', entityId: user.id, details: { email: user.email } }
      )
    })()
    console.log(`Password changed for ${user.email}. New recovery code (write it down): ${code}`)
  })
} catch (e) {
  console.error('ERROR: ' + (e as Error).message)
  process.exitCode = 1
} finally {
  await dbs.close()
}
