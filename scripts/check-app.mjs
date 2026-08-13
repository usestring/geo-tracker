// Is a consumer-app profile actually logged in?
//   bun scripts/check-app.mjs <surface>
//
// Answers that and nothing else. It writes no rows: a verification that leaves
// failure rows behind makes the run history lie about how many measurement
// attempts happened.
//
// This exists because `make apps-check` does NOT answer it - that target runs
// the logged-out Perplexity surface and passes whether or not a login worked.
import { requireApp } from './app-registry.mjs'

const name = process.argv[2]
if (!name) {
  console.error('usage: bun scripts/check-app.mjs <chatgpt-app|claude-app>')
  process.exit(1)
}
const app = requireApp(name)
if (!app.loggedIn) {
  console.log(`${name} runs logged out - nothing to check. Exercise it with: make apps-check`)
  process.exit(0)
}
const { surface } = app

let ctx
try {
  ctx = await surface.launch({ headless: false })
  const page = ctx.pages()[0] ?? (await ctx.newPage())

  console.log(`profile:  ${surface.PROFILE_DIR}`)
  try {
    await surface.assertLoggedIn(page)
    const cookies = await ctx.cookies()
    console.log(`url:      ${page.url()}`)
    console.log(`cookies:  ${cookies.length}`)
    console.log(`\nLOGGED IN. \`make apps\` will run the ${app.label} surface.`)
    process.exit(0)
  } catch (error) {
    const cookies = await ctx.cookies().catch(() => [])
    console.log(`url:      ${page.url()}`)
    console.log(`cookies:  ${cookies.length}`)
    console.log(`\nNOT LOGGED IN. ${String(error).split('\n')[0]}`)
    if (cookies.length <= 2) {
      // The tell-tale state: Cloudflare handed out a bot-management cookie on
      // page load, but the login flow never completed.
      console.log('The profile reached the site but stored almost nothing - the login')
      console.log('was probably never finished (MFA not completed, or window closed early).')
    }
    console.log(`\nFix: ${app.setupTarget}`)
    process.exit(1)
  }
} catch (error) {
  console.log(`check failed: ${error}`)
  process.exit(1)
} finally {
  await ctx?.close().catch(() => {})
}
