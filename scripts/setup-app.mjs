// Headed login for a consumer-app surface:  bun scripts/setup-app.mjs <surface>
//
// You log in by hand. The session is what survives, not a password.
//
// It watches for the login rather than asking you to press Enter, and it never
// closes the window itself. Both of those are scars:
//   - The Enter handshake failed in both directions - close the window early
//     and it saved a profile with no session, finish and forget the terminal
//     and it waited forever.
//   - An earlier version auto-closed on the first session-shaped cookie, which
//     matched a cookie set at the START of the flow and shut the browser
//     mid-login, during the OAuth handoff.
// So: detect, announce, and let the person close the window when they are done
// with the account settings too.
import { requireApp } from './app-registry.mjs'

const name = process.argv[2]
if (!name) {
  console.error('usage: bun scripts/setup-app.mjs <chatgpt-app|claude-app>')
  process.exit(1)
}
const app = requireApp(name)
if (!app.loggedIn) {
  console.log(`${name} runs logged out - there is no login to set up.`)
  process.exit(0)
}
const { surface } = app

const TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS) || 15 * 60_000
const POLL_MS = 3_000

const ctx = await surface.launch({ headless: false })
const page = ctx.pages()[0] ?? (await ctx.newPage())

// A cold profile can abort the first navigation while Chromium settles. That is
// transient and must not kill the login.
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await page.goto(surface.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    break
  } catch (error) {
    console.log(`  navigation attempt ${attempt} failed: ${String(error).split('\n')[0]}`)
    if (attempt === 3) console.log(`  could not auto-navigate - open ${surface.LOGIN_URL} in the window yourself.`)
    else await new Promise((r) => setTimeout(r, 2_000))
  }
}

console.log(`
${app.label} login
Profile: ${surface.PROFILE_DIR}

  1. Log in as ${surface.ACCOUNT_HINT}.
     Finish the WHOLE flow including MFA - the session is only written once you
     are all the way in.
${surface.SETTINGS_STEPS.map((s, i) => `  ${i + 2}. ${s}`).join('\n')}

Watching for the login. Nothing here will close the window on you - when the
session is captured this prints CAPTURED, and you close the window yourself
once the settings above are done.
`)

const deadline = Date.now() + TIMEOUT_MS
let captured = false
let closed = false

ctx.on('close', () => {
  closed = true
})

while (Date.now() < deadline && !closed) {
  await new Promise((r) => setTimeout(r, POLL_MS))
  let ok = false
  try {
    ok = await surface.isLoggedIn(page, ctx)
  } catch {
    closed = true
    break
  }
  if (ok && !captured) {
    captured = true
    console.log(`
CAPTURED - you are logged in.

Now finish these in the same window, then close it yourself:
${surface.SETTINGS_STEPS.map((s) => `  - ${s}`).join('\n')}

Closing the window saves the profile. Verify after with: ${app.checkTarget}`)
  }
}

// Only force the close on timeout. If the window was shut by hand, Chromium has
// already flushed the cookie jar on its way out.
if (!closed) await ctx.close().catch(() => {})

if (captured) {
  console.log(`\nDone. Verify with: ${app.checkTarget}`)
  process.exit(0)
}
console.log('\nNo session appeared - the login did not complete. Nothing was saved.')
console.log(`Re-run ${app.setupTarget}.`)
process.exit(1)
