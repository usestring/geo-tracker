// Which layer is burned when Google starts challenging us: the exit IP, or the
// browser fingerprint?
//
// Run this the moment a SERP pass comes back mostly BLOCKED. It sends ONE AI
// Mode request per egress config and prints the exit IP alongside what Google
// served. Writes no database rows and touches no state.
//
//   cd ~/geo-tracker && set -a && source .env && set +a && bun scripts/probe-google.mjs
//
// Reading it: if some configs answer and others are challenged, the fingerprint
// is fine and a proxy pool's reputation is the problem, so change the tier or
// the country. If every config is challenged with a different exit IP each time,
// the fingerprint is the problem and it needs eng.
//
// Aug 24 2026 was the first case: premium 0 of 7, standard 5 of 6. That moved
// both Google surfaces onto the standard tier.

import puppeteer from 'puppeteer-core'

const KEY = process.env.STRING_API_KEY
if (!KEY) {
  console.error('no STRING_API_KEY in the environment - run with: set -a && source .env && set +a')
  process.exit(1)
}

const QUESTION = 'best web scraping api 2026'
const SKIP = new Set(['image', 'font', 'media'])
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const CONFIGS = [
  { label: 'US premium  (was prod until Aug 24)', proxy: 'premium',  countryCode: 'US' },
  { label: 'US standard (prod since Aug 24)',        proxy: 'standard', countryCode: 'US' },
  { label: 'GB premium  (different country)',   proxy: 'premium',  countryCode: 'GB' },
  { label: 'DE premium  (different country)',   proxy: 'premium',  countryCode: 'DE' },
]

async function probe(cfg) {
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

    const g = `https://www.google.com/search?q=${encodeURIComponent(QUESTION)}&udm=50&hl=en&gl=us`
    await page.goto(g, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await sleep(6000)
    const text = await page.evaluate(() => (document.body.innerText || '').trim())
    const head = text.slice(0, 200).replace(/\s+/g, ' ')
    const blocked = /unusual traffic|not a robot|recaptcha/i.test(text.slice(0, 3000))
    return { ...cfg, exitIp, blocked, chars: text.length, head, ms: Date.now() - t0 }
  } catch (e) {
    return { ...cfg, exitIp: 'n/a', error: String(e?.message ?? e).slice(0, 120), ms: Date.now() - t0 }
  } finally {
    if (browser) await Promise.resolve(browser.disconnect()).catch(()=>{})
  }
}

for (const cfg of CONFIGS) {
  const r = await probe(cfg)
  const verdict = r.error ? 'ERROR' : r.blocked ? 'BLOCKED' : r.chars < 300 ? 'EMPTY' : 'OK'
  console.log(`\n[${verdict}] ${r.label}  exit=${r.exitIp}  ${r.ms}ms`)
  if (r.error) console.log(`   ${r.error}`)
  else console.log(`   ${r.chars} chars | ${r.head}`)
}
