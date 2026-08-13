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

const USE_LOCAL = process.env.AI_MODE_LOCAL === '1' || !process.env.STRING_API_KEY
const SESSION_MAX_MS = Number(process.env.AI_MODE_SESSION_MS ?? 20 * 60 * 1000)
const PROXY_TIER = process.env.AI_MODE_PROXY ?? 'premium'
const COUNTRY = process.env.AI_MODE_COUNTRY ?? 'US'

// Module-level session. `ask()` reads the live page from here rather than the
// one the runner hands it, because a reconnect replaces the page and the runner
// holds whatever it was given at launch.
let session = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cdpUrl() {
  const p = new URLSearchParams({ proxy: PROXY_TIER, countryCode: COUNTRY })
  return `wss://request.usestring.ai/v1/wss?${p}`
}

/** Drop bytes we never read. Bandwidth is what the hosted browser bills. */
const SKIP_TYPES = new Set(['image', 'font', 'media'])

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
    return { close: () => browser.close(), page, openedAt: Date.now(), remote: false }
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: cdpUrl(),
    headers: { Authorization: `Bearer ${process.env.STRING_API_KEY}` }
  })
  const page = (await browser.pages())[0] ?? (await browser.newPage())
  await page.setViewport({ width: 1280, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (SKIP_TYPES.has(req.resourceType())) req.abort().catch(() => {})
    else req.continue().catch(() => {})
  })
  return { close: () => browser.disconnect(), page, openedAt: Date.now(), remote: true }
}

async function closeSession() {
  const s = session
  session = null
  if (s) await Promise.resolve(s.close()).catch(() => {})
}

/** Open a session, or replace one that is stale or has just been blocked. */
async function ensureSession({ force = false } = {}) {
  if (session && !force && Date.now() - session.openedAt < SESSION_MAX_MS) return session
  if (session) {
    console.log(force ? '  reconnecting for a fresh exit IP' : '  session near its 30-min cap, reconnecting')
  }
  await closeSession()
  session = await openSession()
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
  const { page } = await ensureSession()
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
}

export async function ask(page, question, { timeoutMs = 90_000 } = {}) {
  try {
    return await askOnce(question, timeoutMs)
  } catch (e) {
    if (e.code !== 'BLOCKED' || USE_LOCAL) throw e
    // A challenge is tied to the exit IP far more often than to the query, so a
    // fresh session is a real second chance rather than a repeat of the same
    // request. Exactly one retry: three of the Aug 11 failures were content
    // triggered (queries about defeating CAPTCHA and Cloudflare) and those fail
    // from any address. Retrying them harder only spends bandwidth.
    console.log(`  blocked, retrying on a fresh session: ${question.slice(0, 60)}`)
    await ensureSession({ force: true })
    return await askOnce(question, timeoutMs)
  }
}
