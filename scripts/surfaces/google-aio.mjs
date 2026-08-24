// Google AI Overviews (plain /search), logged out — no account, no ToS exposure.
//
// WHY THIS FILE EXISTS (Aug 12, 2026)
// -----------------------------------
// google-aio was the last surface still on the retired Web Access API fetch
// path: one HTTP GET with executeJS, HTML snapshotted, parsed later by
// scripts/serp.ts. That path reported "Google showed no AI Overview" for 48 of
// 50 questions on Aug 12, and had reported a 0.0 mean citation count every day
// for a week. Both numbers were false.
//
// Measured the same day, six daily-core questions in a real browser:
//
//   q1 best web scraping API 2026     tracker: unavailable   real: AI Overview, 26 links
//   q2 best scraping tools for agents tracker: unavailable   real: AI Overview, 21 links
//   q3 best MCP server for web access tracker: unavailable   real: AI Overview, 3963 chars
//   q4 best Firecrawl alternatives    tracker: unavailable   real: AI Overview, 2714 chars
//   q5 best Bright Data alternatives  tracker: unavailable   real: AI Overview, 2171 chars
//   q7 best API for Cloudflare sites  tracker: unavailable   real: AI Overview, 4177 chars
//
// Six of six were false negatives, so the whole google-aio history before this
// change is unusable, not merely noisy.
//
// The cause is timing, and it is the same one that moved AI Mode off the fetch
// path on Aug 10. AI Overviews stream in after load. Probed through the hosted
// browser, q2 has no overview container at t=1s and a 2145-character one with 22
// links at t=9s. A snapshot taken at load therefore records an absence that is
// really an early read.
//
// The old parser was not misreading the page it was given. Google writes the
// literal string "An AI Overview is not available for this search" into the
// pre-generation HTML, and 47 of 50 fetched pages carried it. serp.ts saw it and
// dutifully scored a real negative. The fix is to stop reading the page that
// early, which means a browser, not a better regex.
//
// WHAT THIS DOES DIFFERENTLY FROM THE FETCH PATH
// ----------------------------------------------
//  1. Waits for the overview container to appear AND stop growing, rather than
//     sampling once.
//  2. Never declares "unavailable" early. A block and a settled answer are the
//     only early exits; everything else waits out the full deadline. A question
//     with no overview costs the whole timeout, and that is the intended trade —
//     a fast false negative is exactly the bug being fixed here.
//  3. Scopes citations to the overview container instead of the whole page. The
//     open over-count noted in google-ai-mode.mjs does not apply here: measured
//     on q2, the container yields 21 publisher links where the page yields 175.
//
// Rows keep the model value 'google-aio' so the series name is continuous, and
// carry a per-question serp_state ('answer' | 'unavailable') so extract.ts skips
// the envelope parse. Note the discontinuity: rows before 2026-08-12 came from
// the fetch path and understate both presence and citations.
//
// GOOGLE_AIO_LOCAL=1 forces a local browser. Offline debugging only — from this
// machine Google blocks the home IP outright.
import { createSessionPool, dismissConsent, sleep, blockedError, DEAD_PAGE_RE } from './cdp-session.mjs'

const USE_LOCAL = process.env.GOOGLE_AIO_LOCAL === '1' || !process.env.STRING_API_KEY

const pool = createSessionPool({
  local: USE_LOCAL,
  sessionMs: Number(process.env.GOOGLE_AIO_SESSION_MS ?? 20 * 60 * 1000),
  // 'standard', not 'premium': Google challenges 100% of premium exits as of
  // Aug 24 2026. Full measurement in the PROXY TIER note in google-ai-mode.mjs.
  proxy: process.env.GOOGLE_AIO_PROXY ?? 'standard',
  country: process.env.GOOGLE_AIO_COUNTRY ?? 'US',
})

// Poll cadence, how long the container text must hold still, and the point at
// which a missing overview is finally called absent. The deadline is generous on
// purpose: 9s was enough in the Aug 12 probe, and the cost of waiting too long
// is a slower pass, while the cost of not waiting long enough is the bug above.
const POLL_MS = 1000
const STABLE_MS = 3000
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Locate the AI Overview block.
 *
 * `#m-x-content` is the container Google currently uses and is a readable, named
 * id rather than one of the obfuscated rotating ones — the sibling header id on
 * the same page was `_BSh9auaxA8H9ptQPqoL3kQk_1-header`. It is still Google, so
 * there is a fallback that anchors on the user-visible "AI Overview" label and
 * climbs to the nearest ancestor holding real content. That is the same
 * survive-markup-churn tactic scripts/serp.ts uses.
 *
 * Runs as a string inside page.evaluate so Puppeteer and Playwright both take it.
 */
const FIND_CONTAINER = `
  (() => {
    const byId = document.querySelector('#m-x-content');
    if (byId) return byId;
    const label = [...document.querySelectorAll('h1,h2,h3,div,span,strong')]
      .find((e) => e.children.length === 0 && /^AI Overview$/i.test((e.textContent || '').trim()));
    if (!label) return null;
    let n = label;
    for (let i = 0; i < 8 && n; i++) {
      if ((n.innerText || '').length > 400 && n.querySelectorAll('a[href]').length >= 3) return n;
      n = n.parentElement;
    }
    return null;
  })()
`

/** One poll: what is on the page right now. */
async function readState(page) {
  return page.evaluate(`(() => {
    const c = ${FIND_CONTAINER};
    const body = document.body.innerText || '';
    return {
      present: !!c,
      text: c ? (c.innerText || '').trim() : '',
      blocked: /unusual traffic|not a robot|recaptcha/i.test(body.slice(0, 3000)),
      notice: /not available for this search|Can't generate an AI overview/i.test(body),
      bodyLen: body.length,
    };
  })()`)
}

/** Citations, scoped to the overview container. */
async function readCitations(page) {
  return page.evaluate(`(() => {
    const c = ${FIND_CONTAINER};
    if (!c) return [];
    const out = new Map();
    c.querySelectorAll('a[href]').forEach((a) => {
      let href = a.href;
      if (href.startsWith('https://www.google.com/url?')) {
        const u = new URL(href);
        const q = u.searchParams.get('q') || u.searchParams.get('url');
        if (q) href = q;
      }
      if (!/^https?:\\/\\//.test(href)) return;
      let host;
      try { host = new URL(href).hostname; } catch { return; }
      if (
        /(^|\\.)google\\.(com|[a-z]{2})$/.test(host) ||
        host === 'accounts.google.com' ||
        host === 'support.google.com' ||
        host === 'policies.google.com' ||
        host === 'maps.google.com'
      ) return;
      if (!out.has(href)) out.set(href, { url: href, title: (a.textContent || '').trim().slice(0, 200) });
    });
    return [...out.values()];
  })()`)
}

/**
 * One attempt. Throws with code 'BLOCKED' on a traffic challenge, which is what
 * ask() retries on a fresh exit IP.
 *
 * The runner's `page` argument is deliberately unused: a reconnect replaces the
 * page, and the runner holds whatever it was handed at launch.
 */
async function askOnce(question, timeoutMs) {
  const { page } = await pool.ensure()
  const url = `https://www.google.com/search?q=${encodeURIComponent(question)}&hl=en&gl=us`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await dismissConsent(page)

  const deadline = Date.now() + timeoutMs
  let last = ''
  let stableFor = 0
  let sawNotice = false
  let everPresent = false

  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    const s = await readState(page)
    if (s.blocked) throw blockedError('BLOCKED: Google served a traffic challenge instead of a SERP')
    if (s.notice) sawNotice = true

    if (s.present) {
      everPresent = true
      // Settled? The overview streams token by token, so equal text across two
      // polls is the signal that generation finished.
      if (s.text === last && s.text.length > 200) {
        stableFor += POLL_MS
        if (stableFor >= STABLE_MS) {
          return {
            text: s.text.slice(0, 24000),
            citations: await readCitations(page),
            serpState: 'answer',
          }
        }
      } else {
        stableFor = 0
        last = s.text
      }
    }
  }

  // Deadline reached. An overview that appeared but never settled is still an
  // answer — store what rendered rather than throwing away a real measurement.
  if (everPresent && last.length > 200) {
    return { text: last.slice(0, 24000), citations: await readCitations(page), serpState: 'answer' }
  }

  // Nothing rendered for the whole window. This is the only path that writes a
  // negative, and it costs the full timeout by design.
  return {
    text: sawNotice
      ? 'An AI Overview is not available for this search (Google notice, held for the full wait window).'
      : `No AI Overview container rendered within ${Math.round(timeoutMs / 1000)}s.`,
    citations: [],
    serpState: 'unavailable',
  }
}

export async function launch() {
  await pool.close()
  await pool.ensure()
  return pool.shim()
}

/**
 * The hosted session can drop underneath a question: the remote browser is
 * recycled, the socket closes, and the page handle detaches. Puppeteer reports
 * that as a plain Error with no code, so it has to be matched on message.
 *
 * Seen live on the first full pass (Aug 12, q125: "Attempted to use detached
 * Frame"). Worth a retry for the same reason a block is: the failure is in the
 * transport, not the question, and reconnecting costs one page load. Without
 * this, a mid-pass drop writes an error row for every question that follows.
 */
const RECOVERABLE = DEAD_PAGE_RE

export async function ask(page, question, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    return await askOnce(question, timeoutMs)
  } catch (e) {
    const blocked = e.code === 'BLOCKED'
    const dropped = RECOVERABLE.test(String(e?.message ?? e))
    if ((!blocked && !dropped) || USE_LOCAL) throw e
    // Exactly one retry, either way. A challenge tracks the exit IP far more
    // often than the query, so a fresh session is a real second chance — but
    // some queries (defeating CAPTCHA, defeating Cloudflare) are refused from
    // any address, and retrying those harder only spends bandwidth.
    console.log(
      `  ${blocked ? 'blocked' : 'session dropped'}, retrying on a fresh session: ${question.slice(0, 60)}`
    )
    await pool.ensure({ force: true })
    return await askOnce(question, timeoutMs)
  }
}
