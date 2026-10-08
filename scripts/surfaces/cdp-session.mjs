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

/** Viewport plus the bandwidth filter, applied to every page a session hands out. */
async function preparePage(page) {
  await page.setViewport({ width: 1280, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (SKIP_TYPES.has(req.resourceType())) req.abort().catch(() => {})
    else req.continue().catch(() => {})
  })
  return page
}

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
 * Is this page still usable?
 *
 * A page whose main frame has been destroyed still looks like a page: it answers
 * as an object, `isClosed()` stays false, and every call into it throws
 * `Attempted to use detached Frame '<id>'`. `evaluate` is the cheapest call that
 * actually crosses into the frame, so it is the only probe that catches one.
 *
 * google-ai-mode lost 126 questions to this on Aug 21 because it checked how OLD
 * a session was and never whether it still worked. This module has always had
 * the retry half (see google-aio's RECOVERABLE), but a reconnect is not a clean
 * slate on its own: the hosted endpoint hands the SAME target back, so a dead
 * page can survive the very recycle meant to replace it.
 */
export async function pageIsAlive(page) {
  if (!page || page.isClosed?.()) return false
  try {
    await page.evaluate(() => 1)
    return true
  } catch {
    return false
  }
}

/**
 * A recycling browser session.
 *
 * @param {object} opts
 * @param {boolean} opts.local      Launch a local Chromium instead of connecting out.
 *                                  Offline debugging only: from the host machine
 *                                  Google blocks the home IP outright.
 * @param {number}  opts.sessionMs  Recycle age. Under the hosted 30-minute cap.
 * @param {string}  opts.proxy      Hosted proxy tier: premium | standard.
 * @param {string[]} opts.proxies   Tiers to rotate through on a block-triggered
 *                                  reconnect, in order. Overrides `proxy`.
 * @param {string}  opts.country    Exit country code.
 */
export function createSessionPool({
  local = false,
  sessionMs = 20 * 60 * 1000,
  proxy = 'premium',
  proxies = null,
  country = 'US',
} = {}) {
  let session = null
  let consecutiveOpenFailures = 0

  // TIER ROTATION (Sep 11, 2026). Neither pool is reliably the good one. Aug 24
  // measured premium 0 of 7 and standard 5 of 6, which fixed both Google
  // surfaces on standard. Sep 11 evening measured the reverse on the same
  // code: standard 0 of 24 on a plain SERP, premium 4 of 6. A fixed tier
  // therefore loses whole days whenever the other pool is the one Google is
  // serving. A block now flips the tier on the reconnect it already triggers;
  // age and dead-page reconnects keep the tier, because those are not about
  // the exit IP. Bandwidth is the only cost difference ($5 vs $10 per GB), and
  // a core-day pass on premium with images blocked is under 50 MB.
  const tiers = proxies?.length ? [...proxies] : [proxy]
  let tierIdx = 0

  const cdpUrl = () =>
    `wss://request.usestring.ai/v1/wss?${new URLSearchParams({ proxy: tiers[tierIdx], countryCode: country })}`

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
      // Pages opened on this context inherit its route, so no per-page prep.
      return {
        close: () => browser.close(),
        page,
        freshPage: () => ctx.newPage(),
        openedAt: Date.now(),
        remote: false,
      }
    }

    const browser = await puppeteer.connect({
      browserWSEndpoint: cdpUrl(),
      headers: { Authorization: `Bearer ${process.env.STRING_API_KEY}` },
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
    })

    // The websocket connecting proves nothing: the endpoint accepts it even when
    // the remote browser is gone. The first protocol call is where that shows up,
    // so make it here and refuse to hand back a dead session. Every step through
    // interception setup stays inside this guard: a throw after connect would
    // otherwise leak a live billed websocket until the server's 30-minute kill.
    let page
    try {
      // Probe the reused target before adopting it. `pages()[0]` is often the
      // same page a previous session wedged, and taking it back on faith is how
      // a detached frame outlives its own recycle. A fresh newPage() only needs
      // the probe when it replaces a dead target - its own creation just proved
      // the browser answers.
      page = (await browser.pages())[0] ?? null
      if (page && !(await pageIsAlive(page))) {
        await page.close().catch(() => {})
        page = await browser.newPage()
        if (!(await pageIsAlive(page))) throw new Error('page has no live frame')
      }
      if (!page) page = await browser.newPage()
      await preparePage(page)
    } catch (e) {
      await Promise.resolve(browser.disconnect()).catch(() => {})
      throw new Error(`hosted browser accepted the socket but did not answer: ${e?.message ?? e}`)
    }
    return {
      close: () => browser.disconnect(),
      page,
      /** A new tab in the same context: same cookies, same exit IP. google-ai-mode
       *  opens one per question so Google does not thread them as a conversation. */
      freshPage: async () => preparePage(await browser.newPage()),
      openedAt: Date.now(),
      remote: true,
    }
  }

  async function close() {
    const s = session
    session = null
    if (s) await Promise.resolve(s.close()).catch(() => {})
  }

  /** Open a session, or replace one that is stale or has just been blocked.
   *  `rotate` moves to the next proxy tier first; pass it on a block, not on a
   *  dead page. */
  async function ensure({ force = false, rotate = false } = {}) {
    const stale = !session || Date.now() - session.openedAt >= sessionMs
    // Age is not health: a session well inside its 20 minutes can still be
    // holding a page whose frame died. Probe before handing it back.
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
    if (rotate && tiers.length > 1) {
      tierIdx = (tierIdx + 1) % tiers.length
      console.log(`  switching proxy tier to ${tiers[tierIdx]}`)
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
    tier: () => tiers[tierIdx],
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

/** Google's traffic-challenge page, the /sorry CAPTCHA. Matched on visible text. */
export const SORRY_RE = /unusual traffic|not a robot|recaptcha/i

/**
 * Collect the sources Google cites under `root`, one definition for both
 * Google surfaces. Serialized into page.evaluate, so it is self-contained: no
 * closures, no imports. Pass `questionHead` to also get the read scoped to
 * nodes after the query echo (google-ai-mode's boundary); pass null for the
 * container-scoped read (google-aio hands it the overview container).
 *
 * WHY THREE READS (Sep 11, 2026). Every clean Google row from Aug 27 to Sep 10
 * stored zero citations, on both surfaces, and nothing alerted. Google changed
 * its source markup on Aug 26: the chip anchors went from
 * `/url?q=<destination>` to `/goto?url=<opaque token>` - 118 bytes of
 * ciphertext, no URL in it - so the anchor read found nothing. The destination
 * is still on the page, twice: each chip has a sibling HTML comment
 * `<!--TgQPHd|||[[...]]-->` whose payload carries the favicon lookup, the site
 * name and the full page URL, and the anchor's aria-label sometimes starts with
 * the bare hostname ("www.nimbleway.com (+3) - ..."). Comment nodes are
 * reachable with a TreeWalker, so this costs no request. The payloads carry the
 * page URL only for each chip's first source; the "(+N)" sources behind it give
 * a site root and a /goto token. The tokens come back in `gotos` and
 * resolveGoogleSources turns them into page URLs (Sep 29 2026, see there).
 */
export function collectGoogleSources(root, questionHead) {
  const hostOf = (u) => { try { return new URL(u).hostname } catch { return null } }
  const skip = (h) =>
    !h ||
    /(^|\.)google\.(com|[a-z]{2})$/.test(h) ||
    /(^|\.)(gstatic\.com|googleusercontent\.com|googleadservices\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net|schema\.org|w3\.org)$/.test(h)

  // Document-order position of the query echo. Nodes before it are chrome.
  let boundary = null
  if (questionHead) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent && n.textContent.includes(questionHead)) { boundary = n.parentElement; break }
    }
  }
  const afterBoundary = (node) =>
    boundary === null || (boundary.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  const collect = (filterFn) => {
    const out = new Map()
    const gotos = new Set()
    const addGoto = (t) => { const m = /\/goto\?url=[A-Za-z0-9_-]+/.exec(t || ''); if (m) gotos.add(m[0]) }
    const add = (raw, title) => {
      // Normalize so `https://host` and `https://host/` are one citation, and
      // drop the stray backslash a payload piece can end with.
      const url = raw.replace(/\\+$/, '')
      if (!/^https?:\/\//.test(url) || skip(hostOf(url))) return
      const href = new URL(url).href
      if (!out.has(href)) out.set(href, { url: href, title: (title || '').trim().slice(0, 200) })
    }
    // 1. Plain anchors, with the /url?q= redirect unwrapped (markup before Aug 26 2026).
    root.querySelectorAll('a[href]').forEach((a) => {
      if (!filterFn(a)) return
      let href = a.href
      if (href.startsWith('https://www.google.com/url?')) {
        const p = new URL(href).searchParams
        href = p.get('q') || p.get('url') || href
      }
      add(href, a.textContent)
    })
    // 2. Chip payloads (markup since Aug 26 2026): the full page URL, in a comment.
    //    The payload is a JSON array whose string delimiters arrive as &quot; and
    //    whose = and & arrive as the literal text \u003d and \u0026, so split on
    //    the delimiters first and decode each piece on its own.
    const comments = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
    const unescape = (t) => t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    for (let n = comments.nextNode(); n; n = comments.nextNode()) {
      if (!n.data.startsWith('TgQPHd|||') || !filterFn(n)) continue
      for (const piece of n.data.split(/&quot;|"/)) {
        if (piece.startsWith('http')) add(unescape(piece), '')
        else if (piece.startsWith('/goto?url')) addGoto(unescape(piece))
      }
    }
    // 3. The /goto anchor's label, when it leads with a bare hostname.
    root.querySelectorAll('a[href*="/goto?url="]').forEach((a) => {
      if (!filterFn(a)) return
      addGoto(a.getAttribute('href'))
      const head = (a.getAttribute('aria-label') || '').split(' - ')[0].replace(/\s*\(\+\d+\)\s*$/, '').trim()
      if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(head)) add(`https://${head.replace(/^www\./, '')}/`, head)
    })
    // A bare site root beside a deeper URL on the same host is the favicon
    // lookup's echo, not a second citation.
    const list = [...out.values()]
    const isRoot = (u) => u.pathname.length <= 1 && !u.search
    const deepHosts = new Set(list.map((c) => new URL(c.url)).filter((u) => !isRoot(u)).map((u) => u.hostname))
    const kept = list.filter((c) => { const u = new URL(c.url); return !(isRoot(u) && deepHosts.has(u.hostname)) })
    return { list: kept, gotos: [...gotos] }
  }

  const pw = collect(() => true)
  const sc = collect(afterBoundary)
  return {
    pageWide: pw.list,
    scoped: sc.list,
    boundaryFound: boundary !== null,
    gotos: { pageWide: pw.gotos, scoped: sc.gotos },
  }
}

/**
 * Resolve the /goto tokens collectGoogleSources found and merge the real page
 * URLs into its list. Runs in Node, not in the page.
 *
 * WHY (Sep 29, 2026). Every source card in an AI Overview or AI Mode answer,
 * the chip's first source and the "(+N)" sources behind it, carries a
 * `/goto?url=<token>` link and a comment payload with the site ROOT only
 * ("https://www.reddit.com"). The page URL is in the payload for the first
 * source of a chip, not for the rest. So two Reddit threads read as one
 * citation, and a folded source whose root matched another host was dropped.
 * Measured Sep 29 on "Best Firecrawl alternatives?": the side-panel cards were
 * already in the DOM before any click (clicking every chip and "Show all"
 * added 0 sources), so no click is needed, only the token.
 *
 * The token is server-side and session-free: a plain GET to
 * https://www.google.com/goto?url=<token> with no cookies, from any address,
 * answers 302 with the destination in Location. We read Location with
 * redirect:'manual' and never load the destination. It runs from the tracker
 * host, not the hosted browser, so it costs no browser time and no proxy
 * bandwidth. A token that fails (timeout, 429, no Location) keeps the root the
 * payload gave, so the worst case is the count we had before.
 *
 * GOOGLE_RESOLVE_GOTO=0 turns it off.
 */
export async function resolveGoogleSources(list, gotos, { concurrency = 6, timeoutMs = 5000 } = {}) {
  const stats = { tokens: gotos?.length ?? 0, resolved: 0, failed: 0 }
  if (!gotos?.length || process.env.GOOGLE_RESOLVE_GOTO === '0') return { citations: list, stats }
  const skip = (h) =>
    !h ||
    /(^|\.)google\.(com|[a-z]{2})$/.test(h) ||
    /(^|\.)(gstatic\.com|googleusercontent\.com|googleadservices\.com|googletagmanager\.com|googlesyndication\.com|doubleclick\.net)$/.test(h)
  const found = []
  const queue = [...gotos]
  async function worker() {
    while (queue.length) {
      const path = queue.shift()
      try {
        const res = await fetch(`https://www.google.com${path}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          },
        })
        const loc = res.headers.get('location')
        const u = loc && /^https?:\/\//.test(loc) ? new URL(loc) : null
        if (u && !skip(u.hostname)) { found.push(u.href); stats.resolved++ } else stats.failed++
      } catch {
        stats.failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))

  const out = new Map(list.map((c) => [c.url, c]))
  for (const url of found) if (!out.has(url)) out.set(url, { url, title: '' })
  const all = [...out.values()]
  const isRoot = (u) => u.pathname.length <= 1 && !u.search
  const deepHosts = new Set(all.map((c) => new URL(c.url)).filter((u) => !isRoot(u)).map((u) => u.hostname))
  const citations = all.filter((c) => { const u = new URL(c.url); return !(isRoot(u) && deepHosts.has(u.hostname)) })
  return { citations, stats }
}

/** Source form of the collector, for the surfaces that evaluate strings. */
export const COLLECT_GOOGLE_SOURCES_SRC = collectGoogleSources.toString()

export function blockedError(message) {
  const err = new Error(message)
  err.code = 'BLOCKED'
  return err
}

// Errors that mean the page or transport is gone, not that the question failed.
// Puppeteer words it differently depending on whether the frame, the target, the
// execution context or the whole connection went first, so match the family
// rather than one string. One definition on purpose: surfaces with private
// copies each end up blind to a failure class only the other knows about.
export const DEAD_PAGE_RE =
  /detached frame|target closed|session closed|websocket|protocol error|connection closed|execution context was destroyed|requesting main frame too early/i

// Not a dead page: Google's challenge interstitial navigates on its own, and a
// poll that lands mid-navigation loses its execution context. Keep polling; the
// next read sees either the SERP or the /sorry page. Measured Sep 14 2026 on the
// full-bank pass, where two of these landed as non-block failures on
// google-ai-mode and reset the block counter under the wave pause.
export const MID_NAVIGATION_RE = /execution context was destroyed|cannot find context/i
