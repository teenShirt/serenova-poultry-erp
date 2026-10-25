// Checks a deployed server from the outside after a deployment (staging, then production):
//
//   node scripts/smoke-test.mjs https://staging.example.com [expected-version]
//
// It only reads: no account is needed and no record is created.
const base = (process.argv[2] ?? '').replace(/\/$/, '')
const expected = process.argv[3]
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/smoke-test.mjs <url> [expected-version]')
  process.exit(2)
}

const failures = []
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`FAIL ${name}: ${e.message}`)
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const call = async (method) => {
  const r = await fetch(`${base}/api/call/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pfm' },
    body: '{}'
  })
  must(r.ok, `HTTP ${r.status}`)
  return r.json()
}

await check('liveness /healthz', async () => {
  const r = await fetch(`${base}/healthz`)
  must(r.ok, `HTTP ${r.status}`)
})
await check('readiness /readyz (database at this release’s schema)', async () => {
  const r = await fetch(`${base}/readyz`)
  const body = await r.json()
  must(r.ok && body.status === 'ready', `${r.status} ${JSON.stringify(body)}`)
  if (expected) must(body.version === expected, `version ${body.version}, expected ${expected}`)
  console.log(`     v${body.version} ${body.environment} schema v${body.schema}${body.release ? ' ' + body.release.slice(0, 7) : ''}`)
})
await check('the app page loads with security headers', async () => {
  const r = await fetch(`${base}/`)
  must(r.ok, `HTTP ${r.status}`)
  must((await r.text()).includes('<div id="root">'), 'not the app page')
  must(r.headers.get('content-security-policy'), 'no Content-Security-Policy')
  must(r.headers.get('x-content-type-options') === 'nosniff', 'no X-Content-Type-Options')
  if (base.startsWith('https://')) must(r.headers.get('strict-transport-security'), 'no Strict-Transport-Security on HTTPS')
})
await check('the API answers (app.status)', async () => {
  const s = await call('app.status')
  must(s.ok && s.data.setupComplete !== undefined, JSON.stringify(s).slice(0, 200))
  must(s.data.user === null, 'a signed-in user without a session cookie')
})
await check('the console answers (platform.status)', async () => {
  const s = await call('platform.status')
  must(s.ok && s.data.user === null, JSON.stringify(s).slice(0, 200))
})
await check('requests without the app header are refused', async () => {
  const r = await fetch(`${base}/api/call/app.status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  must(r.status === 403, `HTTP ${r.status}`)
})
await check('protected data needs a sign-in', async () => {
  const s = await call('users.list')
  must(!s.ok && s.code === 'not_logged_in', JSON.stringify(s).slice(0, 200))
})

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nAll smoke checks passed')
