// Shared hosted-browser session for the Google SERP surfaces.
//
// Extracted from google-ai-mode.mjs on Aug 12, 2026, when google-aio moved onto
// the same path. The rules encoded here come from that surface's Aug 11 egress
// change and are repeated in full because they are the reason this file exists:
//
// PUPPETEER, NOT PLAYWRIGHT, and that is not a preference.
// `chromium.connectOverCDP()` hangs against wss://request.usestring.ai/v1/wss
// until timeout, reproduced at 60s and at 180s, never completing a single CDP
// round trip. The endpoint is healthy — the socket opens, Browser.getVersion
// answers, Target.getTargets lists a page. The likely cause is in that listing:
// the page target is already `attached: true` when Playwright connects, and
// Playwright waits on an attachedToTarget event a pre-attached target never
// re-emits. `puppeteer.connect()` against the same URL succeeds in 1.2s. This is
// a filed product bug — portal.usestring.ai/docs/browser/playwright tells
// customers to use playwright-core with connectOverCDP, and that path does not
// work. Do not "fix" a surface by switching it back to Playwright.
//
// Session rules from the /wss docs that callers have to respect:
//   1. Sessions are killed at 30 minutes. A 200-question pass runs longer than
//      that, so one session cannot cover it. Recycle at 20.
//   2. Sessions bill by bandwidth ($10/GB premium, $5/GB standard). A rendered
//      Google SERP with images is megabytes. Images, fonts and media are dropped.
//   3. A blocked question earns one reconnect, because a new session means a new
//      exit IP. That is the entire point of running through the hosted browser.
//
// google-ai-mode.mjs still carries its own copy of this logic. It is working and
// was left untouched during the google-aio fix; folding it onto this module is a
// follow-up, not a prerequisite.
import puppeteer from 'puppeteer-core'
import { chromium } from 'playwright'

/** Drop bytes we never read. Bandwidth is what the hosted browser bills. */
const SKIP_TYPES = new Set(['image', 'font', 'media'])

// Puppeteer's default protocolTimeout is 180s. On Aug 17 the hosted endpoint
// started accepting the websocket while the browser behind it was already gone,
// so the first protocol call (Target.getBrowserContexts) never answered and each
// question burned the full three minutes before failing. 26 of 50 questions went
// that way, all after one dead reconnect. 30s is well above a healthy connect
// (measured at 1.2s) and turns a wedged session into a fast failure.
const PROTOCOL_TIMEOUT_MS = 30_000

// After this many opens in a row fail, the endpoint is down rather than flaky.
// Keep going and every remaining question pays the timeout for the same answer.
const MAX_CONSECUTIVE_OPEN_FAILURES = 3

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A recycling browser session.
 *
 * @param {object} opts
 * @param {boolean} opts.local      Launch a local Chromium instead of connecting out.
 *                                  Offline debugging only: from the host machine
 *                                  Google blocks the home IP outright.
 * @param {number}  opts.sessionMs  Recycle age. Under the hosted 30-minute cap.
 * @param {string}  opts.proxy      Hosted proxy tier: premium | standard.
 * @param {string}  opts.country    Exit country code.
 */
export function createSessionPool({
  local = false,
  sessionMs = 20 * 60 * 1000,
  proxy = 'premium',
  country = 'US',
} = {}) {
  let session = null
  let consecutiveOpenFailures = 0

  const cdpUrl = () =>
    `wss://request.usestring.ai/v1/wss?${new URLSearchParams({ proxy, countryCode: country })}`

  async function open() {
    if (local) {
      const browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
      })
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      })
      await ctx.route('**/*', (route) =>
        SKIP_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue()
      )
      const page = await ctx.newPage()
      return { close: () => browser.close(), page, openedAt: Date.now(), remote: false }
    }

    const browser = await puppeteer.connect({
      browserWSEndpoint: cdpUrl(),
      headers: { Authorization: `Bearer ${process.env.STRING_API_KEY}` },
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
    })

    // The websocket connecting proves nothing: the endpoint accepts it even when
    // the remote browser is gone. The first protocol call is where that shows up,
    // so make it here and refuse to hand back a dead session.
    let page
    try {
      page = (await browser.pages())[0] ?? (await browser.newPage())
      await page.setViewport({ width: 1280, height: 900 })
    } catch (e) {
      await Promise.resolve(browser.disconnect()).catch(() => {})
      throw new Error(`hosted browser accepted the socket but did not answer: ${e?.message ?? e}`)
    }

    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (SKIP_TYPES.has(req.resourceType())) req.abort().catch(() => {})
      else req.continue().catch(() => {})
    })
    return { close: () => browser.disconnect(), page, openedAt: Date.now(), remote: true }
  }

  async function close() {
    const s = session
    session = null
    if (s) await Promise.resolve(s.close()).catch(() => {})
  }

  /** Open a session, or replace one that is stale or has just been blocked. */
  async function ensure({ force = false } = {}) {
    if (session && !force && Date.now() - session.openedAt < sessionMs) return session
    if (session) {
      console.log(
        force ? '  reconnecting for a fresh exit IP' : '  session near its 30-min cap, reconnecting'
      )
    }
    await close()

    // Back off between reconnects. A hosted browser that just dropped us is
    // often still tearing the old session down, and reconnecting into that
    // window is how the wedged state got reached in the first place.
    if (consecutiveOpenFailures > 0) {
      await sleep(Math.min(2000 * 2 ** (consecutiveOpenFailures - 1), 15_000))
    }

    try {
      session = await open()
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

  return {
    ensure,
    close,
    isLocal: () => local,
    /** Runner-shaped shim. A reconnect swaps the real session out, so never hand
     *  the live object to a caller that will hold it for the whole pass. */
    shim: () => ({
      pages: () => [session?.page].filter(Boolean),
      newPage: async () => (await ensure()).page,
      on: () => {},
      close: () => close(),
    }),
  }
}

/**
 * Click a consent button by visible text. Written with page.evaluate so one
 * implementation works on both Puppeteer and Playwright — their locator APIs
 * differ, but evaluate does not.
 */
export async function dismissConsent(page) {
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

export function blockedError(message) {
  const err = new Error(message)
  err.code = 'BLOCKED'
  return err
}
