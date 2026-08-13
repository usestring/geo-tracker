// Perplexity consumer app, logged out — no account needed, so no ToS/ban exposure.
// A challenge or empty answer throws BLOCKED; the caller writes an error row rather
// than recording a zero. There is no silent fallback: a measurement either happened
// against the consumer app or it did not.
import { chromium } from 'playwright'

export async function launch({ headless = true } = {}) {
  const browser = await chromium.launch({ headless, args: ['--disable-blink-features=AutomationControlled'] })
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  ctx.on('close', () => browser.close().catch(() => {}))
  return ctx
}

async function revealSources(page) {
  const candidates = [
    page.getByRole('button', { name: /\d+\s+sources?/i }),
    page.getByRole('tab', { name: /^links$/i }),
    page.getByRole('button', { name: /^links$/i }),
    page.locator('[data-testid*="sources"]'),
  ]
  for (const loc of candidates) {
    try {
      const el = loc.first()
      if (await el.count() && await el.isVisible()) {
        await el.click({ timeout: 5000 })
        await page.waitForTimeout(2000)
        return true
      }
    } catch { /* try the next selector */ }
  }
  return false
}

export async function ask(page, question, { timeoutMs = 150_000 } = {}) {
  const url = `https://www.perplexity.ai/search?q=${encodeURIComponent(question)}`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  const deadline = Date.now() + timeoutMs
  let last = '', stableFor = 0
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    const text = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body
      return (main.innerText || '').trim()
    })
    if (text === last && text.length > 200) { stableFor += 1500 } else { stableFor = 0; last = text }
    if (stableFor >= 4500) break
  }
  if (!last || last.length < 100) {
    const err = new Error('BLOCKED_OR_EMPTY: Perplexity returned no usable answer (likely a challenge)')
    err.code = 'BLOCKED'
    throw err
  }

  // Sources live behind a click ("N sources" pill, or the Links tab) — open it before extracting.
  await revealSources(page)

  const citations = await page.evaluate(() => {
    const out = new Map()
    document.querySelectorAll('a[href^="http"]').forEach(a => {
      const href = a.href
      if (href.includes('perplexity.ai')) return
      if (!out.has(href)) out.set(href, { url: href, title: (a.textContent || '').trim().slice(0, 200) })
    })
    return [...out.values()]
  })

  return { text: last, citations }
}
