// Google AI Overview and AI Mode through String's own search endpoint.
//
// WHY (Sep 29 2026). Both Google surfaces ran in the hosted CDP browser since
// Aug 10-12, and spent every morning fighting Google's traffic challenge: on
// Sep 29 the core pass answered 32/58 (AI Mode) and 43/58 (AI Overview), and
// a two-hour afternoon wave blocked every attempt. We moved both surfaces to
// the search endpoint. POST https://request.usestring.ai/v1/search returns:
//   engine "google"         -> overviews: [{ text, sources: [{ title, url }] }]
//   engine "google_ai_mode" -> aiMode: { text, markdown, blocks, sources: [{ title, url, snippet, source }] }
// Source URLs come back as real page URLs, so none of the /goto token work in
// cdp-session.mjs applies. The block problem becomes the endpoint's to solve.
//
// The Aug 12 lesson still holds: an AI Overview streams in after load, and a
// snapshot taken early reports a false "no overview". search-compare.mjs
// checks presence against the browser rows; re-run it if the unavailable rate
// on google-aio moves.
const ENDPOINT = process.env.STRING_SEARCH_URL ?? 'https://request.usestring.ai/v1/search'
const TIMEOUT_MS = Number(process.env.GOOGLE_SEARCH_TIMEOUT_MS ?? 120_000)
const ATTEMPTS = 3

const skip = (h) => !h || !/^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h) || /(^|\.)google\.(com|[a-z]{2})$/.test(h) || /(^|\.)(gstatic\.com|googleusercontent\.com|googlesyndication\.com|doubleclick\.net)$/.test(h)

function toCitations(sources) {
  const out = new Map()
  for (const s of sources ?? []) {
    let u
    try { u = new URL(s.url) } catch { continue }
    if (!/^https?:$/.test(u.protocol) || skip(u.hostname)) continue
    if (!out.has(u.href)) out.set(u.href, { url: u.href, title: (s.title || '').trim().slice(0, 200) })
  }
  return [...out.values()]
}

async function post(query, engine) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRING_API_KEY}`, 'Content-Type': 'application/json' },
    // aiOverview (Oct 6 2026): without it the endpoint returns a streamed AI
    // Overview as { declined: true } with no text, and about two thirds of
    // overviews stream. Oct 5-6 rows read 56/58 "unavailable" for that reason.
    // It bills as two searches. google_ai_mode rejects the field with a 400.
    body: JSON.stringify({ query, engine, country: 'US', language: 'en', ...(engine === 'google' ? { aiOverview: true } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await res.text()
  if (!res.ok) {
    const err = new Error(`search ${engine} HTTP ${res.status}: ${body.slice(0, 160)}`)
    err.status = res.status
    throw err
  }
  return JSON.parse(body)
}

/**
 * One question, one engine. Returns the runner's shape: { text, citations, serpState }.
 *
 * A missing AI Overview or an answer with zero sources is re-asked up to twice
 * and the richest read is kept (an answer beats "unavailable"). Measured Sep 29 on the 58 core questions: 13 AI Overviews came back
 * with text and no sources, where the browser had read 4-16 on the same
 * questions that morning; re-asking q28 returned 10 and then 7. Presence
 * varies the same way: a second pass had 3 questions with no overview that the
 * browser had seen. A real absence therefore costs three requests, the same
 * trade google-aio.mjs made with its 30s wait (Aug 12).
 */
export async function searchGoogle(query, engine) {
  const score = (r) => (r.serpState === 'answer' ? 1000 : 0) + r.citations.length
  let best = await searchOnce(query, engine)
  for (let i = 0; i < 2 && !best.declined && (best.serpState !== 'answer' || best.citations.length === 0); i++) {
    const again = await searchOnce(query, engine).catch(() => null)
    if (again && score(again) > score(best)) best = again
  }
  return best
}

/** Retries 5xx, 429 and timeouts; a 4xx is a request fault and fails at once. */
async function searchOnce(query, engine) {
  let data
  for (let attempt = 1; ; attempt++) {
    try {
      data = await post(query, engine)
      break
    } catch (e) {
      const retryable = !e.status || e.status >= 500 || e.status === 429
      if (!retryable || attempt >= ATTEMPTS) throw e
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }

  if (engine === 'google_ai_mode') {
    const a = data.aiMode
    const text = (a?.text || a?.markdown || '').trim()
    // AI Mode always writes an answer. An empty one is a failed read, not a
    // negative, so it is an error row rather than a zero-citation answer.
    if (!text) throw new Error('search google_ai_mode returned no aiMode answer')
    return { text: text.slice(0, 24000), citations: toCitations(a.sources), serpState: 'answer' }
  }

  const overviews = (data.overviews ?? []).filter((o) => (o.text || '').trim())
  // With aiOverview set, declined means Google drew the frame and refused to
  // answer. The docs say a retry will not change that, so it is not re-asked.
  if (!overviews.length && (data.overviews ?? []).some((o) => o.declined)) {
    return { text: 'Google declined to write an AI Overview.', citations: [], serpState: 'unavailable', declined: true }
  }
  if (!overviews.length) {
    return {
      text: 'No AI Overview in the search endpoint response.',
      citations: [],
      serpState: 'unavailable',
    }
  }
  return {
    text: overviews.map((o) => o.text.trim()).join('\n\n').slice(0, 24000),
    citations: toCitations(overviews.flatMap((o) => o.sources ?? [])),
    serpState: 'answer',
  }
}

/** Runner-shaped surface for one engine: launch() is a no-op, no browser. */
export function searchSurface(engine) {
  return {
    launch: async () => ({ pages: () => [], newPage: async () => null, on: () => {}, close: async () => {} }),
    ask: (_page, question) => searchGoogle(question, engine),
  }
}
