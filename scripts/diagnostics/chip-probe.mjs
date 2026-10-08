// What sits behind Google's "(+N)" source chips, and how do we read it?
// Since Aug 26 2026 collectGoogleSources reads only the first source of each
// chip; the folded ones load on click. This loads one served SERP (AI Overview)
// and one AI Mode page, lists every chip-like control, clicks them, and prints
// the sources the collector sees before and after. Saves the HTML after the
// clicks to --out. Writes no rows.
//   set -a && source .env && set +a && bun scripts/diagnostics/chip-probe.mjs --out=/tmp
import { createSessionPool, dismissConsent, sleep, SORRY_RE, COLLECT_GOOGLE_SOURCES_SRC } from '../surfaces/cdp-session.mjs'
import { writeFileSync } from 'node:fs'
const argOf = (n) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1]
const OUT = argOf('out') ?? '/tmp'
const Q = argOf('q') ?? 'What is the best project management tool?'
const pool = createSessionPool({ proxies: ['standard', 'premium'], country: 'US' })

async function settle(page, minChars, maxMs) {
  const t0 = Date.now(); let last = '', stable = 0
  while (Date.now() - t0 < maxMs) {
    await sleep(1500)
    let text = ''
    try { text = await page.evaluate(() => (document.body.innerText || '').trim()) } catch { continue }
    if (SORRY_RE.test(text.slice(0, 3000))) throw Object.assign(new Error('BLOCKED'), { code: 'BLOCKED' })
    if (text === last && text.length > minChars) { stable += 1500; if (stable >= 4500) return text } else { stable = 0; last = text }
  }
  return last
}

const COUNT = `(() => {
  const c = document.querySelector('#m-x-content') || document.body;
  const r = (${COLLECT_GOOGLE_SOURCES_SRC})(c, null).pageWide;
  const all = (${COLLECT_GOOGLE_SOURCES_SRC})(document.body, null).pageWide;
  return { container: r.map(x => x.url), page: all.map(x => x.url) };
})()`

// Every control that looks like a source chip or a "show all sources" toggle.
const CHIPS = `(() => {
  const out = [];
  document.querySelectorAll('a, button, [role="button"], [jsaction]').forEach((e, i) => {
    const label = (e.getAttribute('aria-label') || '').trim();
    const text = (e.innerText || '').trim().slice(0, 80);
    if (/\\(\\+\\d+\\)|\\+\\d+\\b/.test(label) || /^\\+\\d+$/.test(text) || /^(show all|view all|all sources|sources)$/i.test(text) || /show all|view related links|all sources/i.test(label)) {
      e.setAttribute('data-chipprobe', String(out.length));
      out.push({ tag: e.tagName, label: label.slice(0, 100), text, href: (e.getAttribute('href') || '').slice(0, 60), inMx: !!e.closest('#m-x-content') });
    }
  });
  return out;
})()`

async function probe(page, name) {
  const before = await page.evaluate(COUNT)
  const chips = await page.evaluate(CHIPS)
  console.log(`\n=== ${name}: ${before.container.length} container sources, ${before.page.length} page-wide; ${chips.length} chip-like controls`)
  chips.slice(0, 25).forEach((c, i) => console.log(`  [${i}] ${c.tag} inMx=${c.inMx} text="${c.text}" label="${c.label}" href=${c.href}`))
  const seen = new Set(before.page)
  for (let i = 0; i < Math.min(chips.length, 12); i++) {
    // A /goto chip is a real link; block navigation by clicking with the
    // default prevented only when it is an anchor with an href to a new page.
    const r = await page.evaluate((i) => {
      const e = document.querySelector(`[data-chipprobe="${i}"]`)
      if (!e) return 'gone'
      e.scrollIntoView({ block: 'center' })
      e.click()
      return 'clicked'
    }, i).catch((e) => `err ${e.message.slice(0, 60)}`)
    await sleep(2500)
    if (!/google\.com\/search/.test(page.url())) { console.log(`  [${i}] ${r} -> navigated to ${page.url().slice(0, 80)}; going back`); await page.goBack().catch(() => {}); await sleep(3000); continue }
    const now = await page.evaluate(COUNT).catch(() => ({ container: [], page: [] }))
    const fresh = now.page.filter(u => !seen.has(u)); fresh.forEach(u => seen.add(u))
    console.log(`  [${i}] ${r}: page-wide now ${now.page.length}, +${fresh.length} new ${fresh.slice(0, 4).map(u => u.slice(0, 70)).join(' | ')}`)
  }
  writeFileSync(`${OUT}/${name}-after.html`, await page.content())
  console.log(`  total distinct after clicks: ${seen.size} (before ${before.page.length})`)
}

let page = null
for (let attempt = 1; attempt <= 6 && !page; attempt++) {
  const s = await pool.ensure({ force: attempt > 1, rotate: attempt > 1 })
  const p = await s.freshPage()
  try {
    await p.goto(`https://www.google.com/search?q=${encodeURIComponent(Q)}&hl=en&gl=us`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await dismissConsent(p)
    await settle(p, 600, 30_000)
    page = p
  } catch (e) { console.log(`attempt ${attempt} (${pool.tier()}): ${e.code ?? e.message.slice(0, 60)}`); await p.close().catch(() => {}) }
}
if (!page) { console.log('no served SERP in 6 attempts'); await pool.close(); process.exit(1) }
console.log(`served on ${pool.tier()}`)
await probe(page, 'serp')

await page.goto(`https://www.google.com/search?q=${encodeURIComponent(Q)}&udm=50&hl=en&gl=us`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await dismissConsent(page)
try { await settle(page, 600, 90_000); await probe(page, 'aim') } catch (e) { console.log(`udm=50: ${e.code ?? e.message}`) }
await pool.close()
