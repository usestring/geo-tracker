// Google AI Mode (udm=50), logged out — no account, so no ToS/ban exposure.
//
// Why this exists: the String-API fetch path snapshots the page at load, but AI
// Mode streams its answer in afterwards, so 97% of fetch rows came back as
// shells with zero answer text (measured Aug 10: 435KB of HTML, 546 chars of
// visible text, no provider names anywhere). The API's `actions` wait path was
// tried first and hangs indefinitely on google.com URLs specifically (works on
// example.com) — flagged to eng as product feedback. Until that is fixed, this
// browser surface owns the measurement, same stability-wait pattern as
// perplexity-app.mjs.
//
// Rows keep the model value 'google-ai-mode' so the trend line continues, and
// are written with serp_state='answer' so extract.ts skips the envelope parse.
//
// ---------------------------------------------------------------------------
// EGRESS (Aug 11, 2026) — why this runs on String's hosted browser
//
// This surface used to call `chromium.launch()`: a local browser on the host machine,
// no proxy. Every question in a pass hit Google from one residential IP, seconds
// apart. That produced 11 blocked questions out of 50 on Aug 11, and by that
// afternoon the IP was blocked outright, named on Google's own page:
//
//   "Our systems have detected unusual traffic from your computer network."
//   IP address: 71.105.13.234
//
// So the local path is finished, not degraded. This connects to String's hosted
// CDP browser instead, giving each session a rotating exit. The session
// machinery (puppeteer not Playwright, 20-minute recycle, bandwidth filter,
// dead-page probe, tier rotation) lives in cdp-session.mjs and is shared with
// google-aio; this file folded onto it on Sep 11, 2026.
//
// ---------------------------------------------------------------------------
// WARM-UP (Sep 11, 2026) — why every AI Mode request follows a plain SERP
//
// Google scores a cookie-less deep link to udm=50 harder than a plain search
// from the same address. Measured on fresh premium sessions, Sep 11 evening,
// round-robin so one block wave could not favour a variant:
//
//   direct udm=50                    0 of 3 served
//   google.com homepage, then udm=50 0 of 3 served
//   plain /search, then udm=50       served 4 of 4 times the SERP was served
//                                    (the SERP itself was refused 2 of 6)
//
// Two paths to the same page, opposite outcomes. A served SERP sets a `DV`
// cookie with a ten-minute life, and the DB says the same thing from the other
// side: every clean run since Sep 1 lasted 6.9-11.8 minutes before blocks
// resumed, on both Google surfaces. So a session is "trusted" for the life of
// that cookie, and re-scored on its IP when it is gone.
//
// askOnce() therefore checks for a live DV cookie and, when there is none,
// loads a plain SERP for the same question before opening udm=50 in the same
// tab. On a good session that is one extra page load per ten minutes, not per
// question. The homepage does not do it: it sets NID and AEC but not DV.
//
// The response chain, for whoever debugs the next wave (scripts/diagnostics/
// block-chain.mjs): a refused search is a 200 interstitial that runs a JS
// challenge, re-requests with `sei=`, and then 302s to /sorry/index, which is
// a 429 carrying reCAPTCHA Enterprise. The hosted browser's wire identity is
// not the trigger — its TLS, HTTP/2 and client-hint fingerprints match real
// Chrome exactly (scripts/diagnostics/hosted-headers.mjs) — the exit IP and the
// absence of DV are.
//
// ---------------------------------------------------------------------------
// PROXY TIER — measured twice, opposite results
//
// Aug 24: premium 0 of 7, standard 5 of 6 (one request per session, fresh exit
// each time), so both Google surfaces moved to standard. Sep 11: standard 0 of
// 24, premium 4 of 6 on the identical request. Neither pool is reliably the
// good one, so the pool now starts on AI_MODE_PROXY (default standard) and
// flips tier on every block-triggered reconnect. Either tier pointed at
// Google gets challenged in waves.
//
// AI_MODE_LOCAL=1 forces a local browser. Offline debugging only — from this
// machine Google blocks the home IP outright.
import {
  createSessionPool,
  dismissConsent,
  sleep,
  blockedError,
  DEAD_PAGE_RE,
  MID_NAVIGATION_RE,
  SORRY_RE,
  COLLECT_GOOGLE_SOURCES_SRC,
  resolveGoogleSources,
} from './cdp-session.mjs'

const USE_LOCAL = process.env.AI_MODE_LOCAL === '1' || !process.env.STRING_API_KEY
const PRIMARY_TIER = process.env.AI_MODE_PROXY ?? 'standard'

const pool = createSessionPool({
  local: USE_LOCAL,
  sessionMs: Number(process.env.AI_MODE_SESSION_MS ?? 20 * 60 * 1000),
  proxies: [PRIMARY_TIER, PRIMARY_TIER === 'premium' ? 'standard' : 'premium'],
  country: process.env.AI_MODE_COUNTRY ?? 'US',
})

// A DV cookie this close to expiry is not worth trusting for a 90s answer poll.
const DV_MIN_LIFE_MS = 60_000
const WARM_POLL_MS = 1000
const WARM_MAX_MS = 10_000

/** Is Google's trust cookie from a served SERP still alive in this context? */
async function hasFreshDv(page) {
  const cookies = await page.cookies('https://www.google.com')
  return cookies.some(
    (c) => c.name === 'DV' && (!(c.expires > 0) || c.expires * 1000 - Date.now() > DV_MIN_LIFE_MS)
  )
}

/**
 * Load a plain SERP for the question unless the session already holds a live
 * DV cookie. Throws BLOCKED on the challenge page; returns 'cached' or 'warmed'.
 * Not reaching 600 chars inside the window is not a failure — the udm=50
 * request that follows is the real test.
 */
async function warmGoogle(page, question) {
  if (await hasFreshDv(page)) return 'cached'
  const url = `https://www.google.com/search?q=${encodeURIComponent(question)}&hl=en&gl=us`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await dismissConsent(page)
  const deadline = Date.now() + WARM_MAX_MS
  while (Date.now() < deadline) {
    await sleep(WARM_POLL_MS)
    let text
    try {
      text = await page.evaluate(() => (document.body.innerText || '').trim())
    } catch (e) {
      if (MID_NAVIGATION_RE.test(String(e?.message ?? e))) continue
      throw e
    }
    if (SORRY_RE.test(text.slice(0, 3000))) {
      throw blockedError('BLOCKED: Google served a traffic challenge instead of a SERP (warm-up)')
    }
    if (text.length > 600) return 'warmed'
  }
  return 'warmed'
}

/**
 * One attempt. Throws with code 'BLOCKED' on a traffic challenge or an empty
 * answer, which is what ask() retries on.
 *
 * The runner's `page` argument is deliberately unused — a reconnect replaces
 * the page, and the runner holds whatever it was given at launch.
 */
async function askOnce(question, timeoutMs) {
  const s = await pool.ensure()
  // ONE TAB PER QUESTION (Aug 24, 2026).
  //
  // AI Mode is a conversation, not a search page. Driving question after
  // question through the same tab makes Google treat them as one thread, and
  // once it does the answer still renders but the source list stops rendering
  // as anchors. The row then looks clean and lands with zero citations.
  //
  // Measured on the Aug 24 repair pass, which reused one tab: 37 of 49 clean
  // rows came back with no citations at all, every one of them after q13. The
  // historical rate is 0-4%. Re-asking four of the same questions on a fresh
  // tab returned 20, 17, 38 and 15 citations, and six questions through one
  // session with a new tab each returned citations 6 times out of 6.
  //
  // This is the worst failure shape the tracker has: no error, real answer
  // text, correct mention data, and silently empty citations. Nothing alerts on
  // it. A new tab is nearly free next to the alternative, which is reconnecting
  // for a new websocket and a new exit IP.
  //
  // google-aio does NOT need this. It was clean on the same pass, 0 of 12.
  const page = await s.freshPage()
  try {
  // Cookies are per context, so the warm-up's DV carries into this tab and
  // into every later tab on the session — see WARM-UP above.
  if ((await warmGoogle(page, question)) === 'warmed') {
    console.log(`  warmed the session with a plain SERP (${pool.tier()})`)
  }

  const url = `https://www.google.com/search?q=${encodeURIComponent(question)}&udm=50&hl=en&gl=us`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await dismissConsent(page)

  // The answer streams token-by-token after load. Poll until the rendered text
  // stops growing (stable 4.5s) — same approach that made perplexity-app work.
  const deadline = Date.now() + timeoutMs
  let last = '',
    stableFor = 0
  while (Date.now() < deadline) {
    await sleep(1500)
    let text
    try {
      text = await page.evaluate(() => (document.body.innerText || '').trim())
    } catch (e) {
      if (MID_NAVIGATION_RE.test(String(e?.message ?? e))) continue
      throw e
    }
    if (SORRY_RE.test(text.slice(0, 3000))) {
      throw blockedError('BLOCKED: Google served a traffic challenge instead of AI Mode')
    }
    if (text === last && text.length > 600) stableFor += 1500
    else {
      stableFor = 0
      last = text
    }
    if (stableFor >= 4500) break
  }

  // Strip SERP chrome: everything before the query echo is nav/tabs.
  const cut = last.indexOf(question.slice(0, 40))
  const answerText = (cut > 0 ? last.slice(cut) : last).trim()
  if (answerText.length < 300) {
    throw blockedError('EMPTY: AI Mode rendered no answer (page text under 300 chars after wait)')
  }

  // Citations: outbound links only. Google wraps some in /url?q= redirects —
  // unwrap those so the ledger sees real domains.
  //
  // KNOWN IMPRECISION: page-wide anchor extraction reads every link on the
  // page, not just the ones inside the answer. On a udm=50 page most links are
  // answer sources, so the count is close, but it is a ceiling rather than a
  // floor. (It is NOT an undercount — that claim was measured false on Aug 11:
  // AI Mode returns a mean of 21.6 citations, the best yield of any surface.)
  //
  // SCOPING (Aug 29, 2026), default OFF. AI_MODE_SCOPE_CITATIONS=1 restricts
  // extraction to anchors that appear after the query echo in document order,
  // which is the same boundary the answer text already uses via `cut` above.
  // Everything before that point is SERP chrome: nav, tabs, account links.
  //
  // It defaults off because this surface is the highest-yield one we run and a
  // wrong selector silently zeroes it. Both counts are returned on every run
  // (citationsPageWide, citationsScoped) whatever the flag says, so a single
  // live pass measures the real delta and flipping the default becomes a
  // decision with data behind it rather than a guess. Turn it on only once the
  // scoped count is confirmed non-zero and lower than the page-wide count.
  //
  // The extractor is collectGoogleSources in cdp-session.mjs, shared with
  // google-aio and driven against a synthetic DOM by tests/ai-mode-citations.
  const SCOPE_CITATIONS = process.env.AI_MODE_SCOPE_CITATIONS === '1'
  const extracted = await page.evaluate(
    `(${COLLECT_GOOGLE_SOURCES_SRC})(document, ${JSON.stringify(question.slice(0, 40))})`
  )

  // Never let scoping return an empty list when the page-wide read found links:
  // an empty scoped result means the boundary heuristic missed, not that the
  // answer had no sources.
  const useScoped = SCOPE_CITATIONS && extracted.boundaryFound && extracted.scoped.length > 0
  // The folded "(+N)" sources: resolve their /goto tokens to page URLs.
  const { citations } = await resolveGoogleSources(
    useScoped ? extracted.scoped : extracted.pageWide,
    (useScoped ? extracted.gotos?.scoped : extracted.gotos?.pageWide) ?? []
  )

  return {
    text: answerText.slice(0, 24000),
    citations,
    citationsPageWide: extracted.pageWide.length,
    citationsScoped: extracted.scoped.length,
    citationScopeApplied: useScoped
  }
  } finally {
    await page.close().catch(() => {})
  }
}

export async function launch() {
  await pool.close()
  await pool.ensure()
  // The runner wants something context-shaped. The shim reads the live session
  // on every call, so a reconnect underneath it is invisible to the runner.
  return pool.shim()
}

// Three attempts: the current tier, then one on each tier after a block flips
// it. A challenge is tied to the exit IP far more often than to the query, so
// a fresh session is a real second chance rather than a repeat of the same
// request. Some queries (defeating CAPTCHA, defeating Cloudflare) are refused
// from any address; three attempts bounds what those can spend, at ~5s and
// ~50KB per blocked attempt.
//
// A detached frame is not a second chance, it is the only chance: the page
// never heals, so without a retry the rest of the pass fails on the same id.
// It keeps the tier — the exit IP was not the problem.
const MAX_ATTEMPTS = 3

export async function ask(page, question, { timeoutMs = 90_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await askOnce(question, timeoutMs)
    } catch (e) {
      const blocked = e.code === 'BLOCKED'
      const dead = DEAD_PAGE_RE.test(String(e?.message ?? e))
      if ((!blocked && !dead) || USE_LOCAL || attempt >= MAX_ATTEMPTS) throw e
      console.log(
        `  ${dead ? 'page died' : 'blocked'}, retrying on a fresh session (${attempt}/${MAX_ATTEMPTS}): ${question.slice(0, 60)}`
      )
      await pool.ensure({ force: true, rotate: blocked })
    }
  }
}
