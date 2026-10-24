/**
 * Creates a Serenova platform administrator (Super Admin) for the console at #/platform.
 * Platform administrators can only be created here, on the server, never from a browser.
 *
 *   npm run create-super-admin -- --list
 *   npm run create-super-admin -- <email address> "<display name>"   (asks for the password)
 *   npm run create-super-admin -- --disable <email address>
 *   npm run create-super-admin -- --enable <email address>
 *
 * The console manages organizations, plans and subscriptions. It does not show any organization's
 * farm records; every action in it is recorded in the platform audit log.
 */
import readline from 'node:readline/promises'
import { loadConfig } from '../src/server/config'
import { Databases } from '../src/server/databases'
import { createPlatformUser, platformAudit } from '../src/server/services/platform'

const args = process.argv.slice(2)
const dbs = await Databases.open(loadConfig())
try {
  await dbs.with('farm', async (db) => {
    const toggle = args.includes('--disable') ? 0 : args.includes('--enable') ? 1 : null
    const positional = args.filter((a) => !a.startsWith('--'))
    if (args.includes('--list') || !positional.length) {
      const rows = (await db.prepare('SELECT email, display_name, active, last_login_at FROM platform_users ORDER BY email').all()) as {
        email: string
        display_name: string
        active: number
        last_login_at: string | null
      }[]
      if (!rows.length) console.log('No platform administrators yet.')
      for (const r of rows) console.log(`${r.email.padEnd(40)} ${r.display_name}${r.active ? '' : ' (disabled)'}  last sign-in: ${r.last_login_at ?? 'never'}`)
      if (!positional.length) console.log('\nUsage: npm run create-super-admin -- <email address> "<display name>"')
      return
    }
    const email = positional[0]!.trim().toLowerCase()
    if (toggle !== null) {
      const r = await db.prepare('UPDATE platform_users SET active = ? WHERE email = ?').run(toggle, email)
      if (r.changes !== 1) throw new Error(`No platform administrator with the email address ${email}`)
      if (!toggle) await db.prepare('DELETE FROM sessions WHERE platform_user_id = (SELECT id FROM platform_users WHERE email = ?)').run(email)
      await platformAudit(db, null, toggle ? 'enable_platform_user' : 'disable_platform_user', null, { email })
      console.log(`${email} ${toggle ? 'enabled' : 'disabled'}.`)
      return
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const password = (await rl.question(`Password for ${email} (at least 10 characters): `)).trim()
    rl.close()
    await createPlatformUser(db, { email, displayName: positional[1] ?? email, password })
    console.log(`Platform administrator ${email} created. Sign in at /#/platform`)
  })
} catch (e) {
  console.error('ERROR: ' + (e as Error).message)
  process.exitCode = 1
} finally {
  await dbs.close()
}
