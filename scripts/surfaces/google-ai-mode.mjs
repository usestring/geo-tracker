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
// apart. That produced 11 blocked questions out of 50 on Aug 11, with 8 of the
// 11 consecutive at the tail — a rate threshold, not headless detection, since
// the same browser and fingerprint had already answered 39 questions.
//
// By that afternoon the IP was blocked outright. Google says so on the page it
// serves, naming the address:
//
//   "Our systems have detected unusual traffic from your computer network."
//   IP address: 71.105.13.234
//
// So the local path is not degraded, it is finished. This connects to String's
// hosted CDP browser instead, giving each session a rotating residential exit.
// It also means the tracker dogfoods the Web Access API on the one surface that
// was bypassing it.
//
// PUPPETEER, NOT PLAYWRIGHT, and that is not a preference:
// `chromium.connectOverCDP()` hangs against wss://request.usestring.ai/v1/wss
// until timeout, reproduced at 60s and at 180s, never completing a single CDP
// round trip. The endpoint itself is healthy — the socket opens, Browser.getVersion
// returns Chrome/151.0.7922.108, Target.getTargets lists a page, and
// Target.setDiscoverTargets fires targetCreated. The likely cause is in that
// listing: the page target is already `attached: true` when Playwright connects,
// and Playwright waits on an attachedToTarget event that a pre-attached target
// never re-emits. `puppeteer.connect()` against the same URL succeeds in 1.2s.
//
// This is a real product bug: portal.usestring.ai/docs/browser/playwright tells
// customers to use playwright-core with connectOverCDP, and that path does not
// work. Filed for eng.
//
// Session rules from the /wss docs that this file has to respect:
//   1. Sessions are killed at 30 minutes. The Sunday 200-question pass runs
//      60-90 minutes, so one session cannot cover it. We recycle at 20.
//   2. Sessions bill by bandwidth ($10/GB premium, $5/GB standard). A rendered
//      Google SERP with images is megabytes. We drop images, fonts and media.
//   3. A blocked question earns one reconnect, because a new session means a new
//      exit IP. That is the entire point of the change.
//
// AI_MODE_LOCAL=1 forces the old local browser. It is for offline debugging
// only — from this machine Google now blocks it outright.
import puppeteer from 'puppeteer-core'
import { chromium } from 'playwright'
import { pageIsAlive, sleep, DEAD_PAGE_RE } from './cdp-session.mjs'

const USE_LOCAL = process.env.AI_MODE_LOCAL === '1' || !process.env.STRING_API_KEY
const SESSION_MAX_MS = Number(process.env.AI_MODE_SESSION_MS ?? 20 * 60 * 1000)
// ---------------------------------------------------------------------------
// PROXY TIER (Aug 24, 2026) — why this is 'standard' and not 'premium'
//
// On Aug 24 the SERP pass failed 43 of 43 questions, every one a Google traffic
// challenge. Not a crash and not the detached-frame bug: Google simply refused
// every request. The Aug 11 hosted-browser move had held at 1 block in 50, so
// something changed underneath us rather than in this code.
//
// Measured the same afternoon, one AI Mode request per session, fresh exit IP
// each time (probe kept at scripts/probe-google.mjs):
//
//   premium  / US   0 of 7 answered   76.86.251.150, 65.30.162.75, 173.189.209.102,
//                                     24.16.248.156, 108.214.128.241, 98.50.109.94 ...
//   standard / US   5 of 6 answered   134.199.87.96, 193.46.204.143, 91.92.23.177 ...
//   premium  / DE   0 of 1 answered
//   GB       / premium  answered, but behind the EU consent wall
//
// Seven different premium exit IPs, seven challenges. So this is not one burned
// address, it is the whole premium residential pool: Google has flagged the
// range. The standard pool is a different set of addresses and still answers.
// The browser fingerprint is not the problem — the same puppeteer build, the
// same headers and the same page code pass on standard and fail on premium.
//
// Standard also bills at $5/GB instead of $10/GB, so this is cheaper, not a
// trade. Set AI_MODE_PROXY=premium to go back if the pool's reputation recovers.
//
// One block still earns one reconnect (see ask() below). At an 83% per-request
// pass rate that retry puts the surface near 97%, so forcing a fresh session on
// every question would add connect latency and spend for very little.
//
// FOR ENG, not just for the tracker: a customer pointing the premium tier at
// Google gets a challenge page 100% of the time. That is a product defect.
// ---------------------------------------------------------------------------
const PROXY_TIER = process.env.AI_MODE_PROXY ?? 'standard'
const COUNTRY = process.env.AI_MODE_COUNTRY ?? 'US'

// Module-level session. `ask()` reads the live page from here rather than the
// one the runner hands it, because a reconnect replaces the page and the runner
// holds whatever it was given at launch.
let session = null

function cdpUrl() {
  const p = new URLSearchParams({ proxy: PROXY_TIER, countryCode: COUNTRY })
  return `wss://request.usestring.ai/v1/wss?${p}`
}

/** Drop bytes we never read. Bandwidth is what the hosted browser bills. */
const SKIP_TYPES = new Set(['image', 'font', 'media'])

// After this many opens in a row fail, the endpoint is down rather than flaky.
// Keep going and every remaining question pays the reconnect for the same answer.
const MAX_CONSECUTIVE_OPEN_FAILURES = 3
let consecutiveOpenFailures = 0

// ---------------------------------------------------------------------------
// DEAD PAGES (Aug 24, 2026) — why liveness is checked instead of assumed
//
// A Puppeteer page whose main frame has been destroyed still looks like a page.
// It answers as an object, `isClosed()` stays false, and every call into it
// throws `Attempted to use detached Frame '<id>'`. Nothing in the session
// bookkeeping noticed, because `ensureSession` only ever asked how OLD the
// session was.
//
// Measured on the Aug 21 full-bank pass: q61 answered at 17:13:51, one frame
// detached, and q62 through q200 then failed 126 times in a row on the SAME
// frame id over the next ten minutes. Two things kept it dead:
//
//   1. `ensureSession` returned the cached session on age alone, so a page with
//      no frame was handed to every following question.
//   2. The 20-minute recycle did not rescue it. The hosted endpoint gives the
//      same target back on reconnect, so disconnect-then-connect returned the
//      identical dead page — which is why one frame id spans the whole window,
//      including past the 17:18 recycle that was supposed to fix it.
//
// So the page is probed before use, and a reconnect that gets the same dead
// target opens a fresh one instead of trusting `pages()[0]`. The probe
// (pageIsAlive) and the dead-transport classifier (DEAD_PAGE_RE) live in
// cdp-session.mjs so both Google surfaces stay on one definition of "dead".
// ---------------------------------------------------------------------------

const isDeadPage = (e) => DEAD_PAGE_RE.test(String(e?.message ?? e))

async function openSession() {
  if (USE_LOCAL) {
    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    })
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    })
    await ctx.route('**/*', (route) =>
      SKIP_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue()
    )
    const page = await ctx.newPage()
    return {
      close: () => browser.close(),
      page,
      freshPage: () => ctx.newPage(),
      openedAt: Date.now(),
      remote: false
    }
  }

  // Same 180s default protocolTimeout trap that wedged google-aio on Aug 17: a
  // dead hosted session makes every protocol call hang for three minutes instead
  // of failing. This file still carries its own copy of the session logic; when
  // it folds onto cdp-session.mjs this constant goes with it.
  const browser = await puppeteer.connect({
    browserWSEndpoint: cdpUrl(),
    headers: { Authorization: `Bearer ${process.env.STRING_API_KEY}` },
    protocolTimeout: 30_000
  })
  // Reconnecting does NOT hand back a clean page — see the DEAD PAGES note
  // above. Probe the reused target and open a new one when its frame is gone,
  // otherwise a wedged page survives every recycle meant to replace it. Every
  // step through interception setup stays inside this guard: a throw after
  // connect would otherwise leak a live billed websocket until the server's
  // 30-minute kill. A fresh newPage() only needs the probe when it replaces a
  // dead target - its own creation just proved the browser answers.
  try {
    let page = (await browser.pages())[0] ?? null
    if (page && !(await pageIsAlive(page))) {
      await page.close().catch(() => {})
      page = await browser.newPage()
      if (!(await pageIsAlive(page))) throw new Error('page has no live frame')
    }
    if (!page) page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (SKIP_TYPES.has(req.resourceType())) req.abort().catch(() => {})
      else req.continue().catch(() => {})
    })
    return {
      close: () => browser.disconnect(),
      page,
      freshPage: async () => {
        const fresh = await browser.newPage()
        await fresh.setViewport({ width: 1280, height: 900 })
        await fresh.setRequestInterception(true)
        fresh.on('request', (req) => {
          if (SKIP_TYPES.has(req.resourceType())) req.abort().catch(() => {})
          else req.continue().catch(() => {})
        })
        return fresh
      },
      openedAt: Date.now(),
      remote: true
    }
  } catch (e) {
    await Promise.resolve(browser.disconnect()).catch(() => {})
    throw new Error(`hosted browser accepted the socket but did not answer: ${e?.message ?? e}`)
  }
}

async function closeSession() {
  const s = session
  session = null
  if (s) await Promise.resolve(s.close()).catch(() => {})
}

/** Open a session, or replace one that is stale, dead, or has just been blocked. */
async function ensureSession({ force = false } = {}) {
  const stale = !session || Date.now() - session.openedAt >= SESSION_MAX_MS
  // Age is not health. A session inside its 20 minutes can still be holding a
  // page whose frame died, which is exactly what burned 126 questions on Aug 21.
  if (session && !force && !stale && (await pageIsAlive(session.page))) return session
  if (session) {
    console.log(
      force
        ? '  reconnecting for a fresh exit IP'
        : stale
          ? '  session past its recycle age, reconnecting'
          : '  page lost its frame, reconnecting'
    )
  }
  await closeSession()

  // Back off between reconnects. A hosted browser that just dropped us is often
  // still tearing the old session down, and reconnecting into that window is how
  // the wedged state gets reached in the first place.
  if (consecutiveOpenFailures > 0) {
    await sleep(Math.min(2000 * 2 ** (consecutiveOpenFailures - 1), 15_000))
  }

  try {
    session = await openSession()
    consecutiveOpenFailures = 0
  } catch (e) {
    consecutiveOpenFailures += 1
    if (consecutiveOpenFailures >= MAX_CONSECUTIVE_OPEN_FAILURES) {
      const err = new Error(
        `hosted browser unreachable after ${consecutiveOpenFailures} attempts: ${e?.message ?? e}`
      )
      err.code = 'SESSION_POOL_DEAD'
      throw err
    }
    throw e
  }
  return session
}

export async function launch() {
  await closeSession()
  session = await openSession()
  // The runner wants something context-shaped. Hand back a shim rather than the
  // live object: a reconnect swaps the real one out, and the runner would
  // otherwise keep driving a closed session.
  return {
    pages: () => [session?.page].filter(Boolean),
    newPage: async () => (await ensureSession()).page,
    on: () => {},
    close: () => closeSession()
  }
}

// Click a consent button by visible text. Written with page.evaluate so the one
// implementation works on both Puppeteer and Playwright — their locator APIs
// differ, but evaluate does not.
async function dismissConsent(page) {
  // US exits rarely see the consent wall, but a non-US proxy or a Google
  // experiment can surface it. Accept-all keeps the page consistent with what a
  // normal buyer sees.
  const clicked = await page.evaluate(() => {
    const wanted = /^(accept all|i agree|accept)$/i
    for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"]')) {
      const label = (el.innerText || el.value || '').trim()
      if (wanted.test(label)) {
        el.click()
        return true
      }
    }
    return false
  })
  if (clicked) await sleep(1500)
}

/**
 * One attempt. Throws with code 'BLOCKED' on a traffic challenge or an empty
 * answer, which is what ask() retries on.
 *
 * The runner's `page` argument is deliberately unused — see the note on
 * `session` above.
 */
async function askOnce(question, timeoutMs) {
  const s = await ensureSession()
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
    const text = await page.evaluate(() => (document.body.innerText || '').trim())
    if (/unusual traffic|not a robot|recaptcha/i.test(text.slice(0, 3000))) {
      const err = new Error('BLOCKED: Google served a traffic challenge instead of AI Mode')
      err.code = 'BLOCKED'
      throw err
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
    const err = new Error('EMPTY: AI Mode rendered no answer (page text under 300 chars after wait)')
    err.code = 'BLOCKED'
    throw err
  }

  // Citations: outbound links only. Google wraps some in /url?q= redirects —
  // unwrap those so the ledger sees real domains.
  //
  // KNOWN IMPRECISION: this reads every anchor on the page, not just the ones
  // inside the answer's source list. On a udm=50 page most links are answer
  // sources, so the count is close, but it is a slight ceiling rather than a
  // floor. Scoping this to the source container is the open improvement.
  // (It is NOT an undercount — that claim was measured false on Aug 11: AI Mode
  // returns a mean of 21.6 citations, the best yield of any surface we run.)
  const citations = await page.evaluate(() => {
    const out = new Map()
    document.querySelectorAll('a[href]').forEach((a) => {
      let href = a.href
      if (href.startsWith('https://www.google.com/url?')) {
        const q = new URL(href).searchParams.get('q') || new URL(href).searchParams.get('url')
        if (q) href = q
      }
      if (!/^https?:\/\//.test(href)) return
      const host = new URL(href).hostname
      if (
        /(^|\.)google\.(com|[a-z]{2})$/.test(host) ||
        host === 'accounts.google.com' ||
        host === 'support.google.com' ||
        host === 'policies.google.com' ||
        host === 'maps.google.com'
      )
        return
      if (!out.has(href)) out.set(href, { url: href, title: (a.textContent || '').trim().slice(0, 200) })
    })
    return [...out.values()]
  })

  return { text: answerText.slice(0, 24000), citations }
  } finally {
    await page.close().catch(() => {})
  }
}

export async function ask(page, question, { timeoutMs = 90_000 } = {}) {
  try {
    return await askOnce(question, timeoutMs)
  } catch (e) {
    const dead = isDeadPage(e)
    if ((e.code !== 'BLOCKED' && !dead) || USE_LOCAL) throw e
    // A challenge is tied to the exit IP far more often than to the query, so a
    // fresh session is a real second chance rather than a repeat of the same
    // request. Exactly one retry: three of the Aug 11 failures were content
    // triggered (queries about defeating CAPTCHA and Cloudflare) and those fail
    // from any address. Retrying them harder only spends bandwidth.
    //
    // A detached frame is not a second chance, it is the only chance: the page
    // never heals, so without this the rest of the pass fails on the same id.
    console.log(
      `  ${dead ? 'page died' : 'blocked'}, retrying on a fresh session: ${question.slice(0, 60)}`
    )
    await ensureSession({ force: true })
    return await askOnce(question, timeoutMs)
  }
}
