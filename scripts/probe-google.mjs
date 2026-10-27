// Which layer is burned when Google starts challenging us: the exit IP, or the
// browser fingerprint?
//
// Run this the moment a SERP pass comes back mostly BLOCKED. It sends a few
// requests per egress config and prints the exit IPs alongside what Google
// served. Writes no database rows and touches no state.
//
//   cd ~/geo-tracker && set -a && source .env && set +a && bun scripts/probe-google.mjs
//
// Flags:
//   --surface=google-aio       probe only that surface (default: both)
//   --samples=N                requests per config per surface (default 3)
//
// Reading it: if some configs answer and others are challenged, the fingerprint
// is fine and a proxy pool's reputation is the problem, so change the tier or
// the country. If every config is challenged with a different exit IP each time,
// the browser fingerprint is the problem, not the pool.
//
// Aug 24 2026 was the first case: premium 0 of 7, standard 5 of 6. That moved
// both Google surfaces onto the standard tier.
//
// TWO SURFACES, TWO URLS (fixed 2026-09-01). This probe used to request only
// the udm=50 URL, which is the google-ai-mode path. google-aio uses plain
// /search. So on a google-aio wipe the probe measured a DIFFERENT surface than
// the broken one and could not diagnose it - exactly what happened on Sep 1,
// when google-aio went 0 of 22 and the probe reported on AI Mode instead.
// It now probes both paths and labels each result with the surface it belongs
// to. Use --surface to probe just the one that broke.
//
// REPEATED SAMPLES (added 2026-09-01). Blocks arrive in waves, so ONE request
// per config is noise. Measured Aug 25: the probe called all four configs
// BLOCKED in the same hour that google-ai-mode scored 31 of 50 clean on the
// very path the probe tested. A config that answers some of the time is a hot
// pool, not a dead one - read the ratio, not a single verdict.

import puppeteer from 'puppeteer-core'

const KEY = process.env.STRING_API_KEY
if (!KEY) {
  console.error('no STRING_API_KEY in the environment - run with: set -a && source .env && set +a')
  process.exit(1)
}

const args = process.argv.slice(2)
const argOf = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const QUESTION = 'best web scraping api 2026'
const SKIP = new Set(['image', 'font', 'media'])
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const SAMPLES = Math.max(1, Number(argOf('samples') ?? 3))

// The two Google surfaces the tracker measures, each with its own URL. A wipe
// on one says nothing about the other, so name the surface in every line.
const ALL_SURFACES = [
  {
    key: 'google-ai-mode',
    label: 'AI Mode (udm=50)',
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=50&hl=en&gl=us`,
  },
  {
    key: 'google-aio',
    label: 'AI Overview (plain /search)',
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=us`,
  },
]

const only = argOf('surface')
const SURFACES = only ? ALL_SURFACES.filter(s => s.key === only) : ALL_SURFACES
if (!SURFACES.length) {
  console.error(`unknown --surface=${only} - expected one of: ${ALL_SURFACES.map(s => s.key).join(', ')}`)
  process.exit(1)
}

const CONFIGS = [
  { label: 'US premium  (was prod until Aug 24)', proxy: 'premium',  countryCode: 'US' },
  { label: 'US standard (prod since Aug 24)',     proxy: 'standard', countryCode: 'US' },
  { label: 'GB premium  (different country)',     proxy: 'premium',  countryCode: 'GB' },
  { label: 'DE premium  (different country)',     proxy: 'premium',  countryCode: 'DE' },
]

async function probe(cfg, surface) {
  const url = `wss://request.usestring.ai/v1/wss?${new URLSearchParams({ proxy: cfg.proxy, countryCode: cfg.countryCode })}`
  let browser
  const t0 = Date.now()
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: url,
      headers: { Authorization: `Bearer ${KEY}` },
      protocolTimeout: 30_000,
    })
    let page = (await browser.pages())[0] ?? await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', r => SKIP.has(r.resourceType()) ? r.abort().catch(()=>{}) : r.continue().catch(()=>{}))

    // What IP does this session actually exit from? Names the burned address.
    let exitIp = 'unknown'
    try {
      await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      exitIp = JSON.parse(await page.evaluate(() => document.body.innerText)).ip
    } catch (e) { exitIp = `lookup failed: ${String(e.message).slice(0,50)}` }

    await page.goto(surface.url(QUESTION), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await sleep(6000)
    const text = await page.evaluate(() => (document.body.innerText || '').trim())
    const head = text.slice(0, 200).replace(/\s+/g, ' ')
    const blocked = /unusual traffic|not a robot|recaptcha/i.test(text.slice(0, 3000))
    // An EU consent wall is a long page with no block text, so it used to score
    // OK and read as "this config works" when no result was ever served. Seen
    // on GB and DE exits, 2026-09-01.
    const consent = /before you continue to google|we use cookies and data/i.test(text.slice(0, 3000))
    return { ...cfg, exitIp, blocked, consent, chars: text.length, head, ms: Date.now() - t0 }
  } catch (e) {
    return { ...cfg, exitIp: 'n/a', error: String(e?.message ?? e).slice(0, 120), ms: Date.now() - t0 }
  } finally {
    if (browser) await Promise.resolve(browser.disconnect()).catch(()=>{})
  }
}

const verdictOf = (r) =>
  r.error ? 'ERROR'
  : r.blocked ? 'BLOCKED'
  : r.consent ? 'CONSENT'
  : r.chars < 300 ? 'EMPTY'
  : 'OK'

for (const surface of SURFACES) {
  console.log(`\n=== ${surface.key} - ${surface.label} - ${SAMPLES} sample(s) per config ===`)
  for (const cfg of CONFIGS) {
    const results = []
    for (let i = 0; i < SAMPLES; i++) results.push(await probe(cfg, surface))

    const ok = results.filter(r => verdictOf(r) === 'OK').length
    const ips = [...new Set(results.map(r => r.exitIp))].join(', ')
    const verdicts = results.map(verdictOf).join('/')
    console.log(`\n[${ok}/${SAMPLES} OK] ${cfg.label}  ${verdicts}`)
    console.log(`   exit IPs: ${ips}`)
    const sample = results.find(r => verdictOf(r) === 'OK') ?? results[0]
    if (sample.error) console.log(`   ${sample.error}`)
    else console.log(`   ${sample.chars} chars | ${sample.head}`)
  }
}
