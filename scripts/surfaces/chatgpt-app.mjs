// ChatGPT consumer app runner.
// Uses a persistent browser profile so the login survives between runs.
// EVERY query runs in a temporary chat: nothing is written to history, memory is not read.
import { chromium } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'

// scripts/surfaces/ -> repo root
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PROFILE_DIR = join(ROOT, 'profiles', 'chatgpt')
export const LOGIN_URL = 'https://chatgpt.com/'
const TEMP_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true'

export const ACCOUNT_HINT = 'a DEDICATED measurement account, in the same dedicated org as the API keys in .env'
export const SETTINGS_STEPS = [
  'Settings -> Personalization -> turn MEMORY OFF.',
  'Settings -> Personalization -> clear CUSTOM INSTRUCTIONS entirely (they apply inside temporary chats too).',
  "Confirm you are in the measurement workspace, not Personal.",
]

// Strict on purpose: __Secure-next-auth.callback-url is set the moment the
// login page loads, so a loose prefix match reports a half-finished login as a
// live session. Checked against the page's own composer as well.
export async function isLoggedIn(page, ctx) {
  try {
    const cookies = await ctx.cookies()
    return cookies.some(
      (c) => /^__Secure-next-auth\.session-token(\.\d+)?$/.test(c.name) || c.name === '__Session'
    )
  } catch {
    return false
  }
}

// HEADED ONLY, deliberately - the `headless` argument is accepted and ignored.
// Cloudflare serves headless Chromium the "Just a moment..." interstitial on
// chatgpt.com even with a perfectly valid session, so the composer never
// renders and every question fails. That failure is indistinguishable from an
// expired login by the time it reaches the runner, so allowing headless here
// would mostly generate misleading SESSION_DEAD alerts. A visible window is the
// cost of measuring this surface at all.
export async function launch(_opts = {}) {
  clearStaleLocks()
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  })
}

// A crashed or force-killed Chromium leaves Singleton* behind, and the next
// launch then either aborts its first navigation or silently attaches to
// "an existing browser session" and returns a context that drives nothing.
// Access here is serialized (one weekly pass, one setup at a time), so clearing
// these on the way in is safe and saves a confusing manual cleanup.
function clearStaleLocks() {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      rmSync(join(PROFILE_DIR, name), { force: true })
    } catch {
      // never block a launch on lock cleanup
    }
  }
}

// Throws SESSION_DEAD when the profile is logged out — callers must fail the run loudly
// rather than recording zeros as if they were measurements.
export async function assertLoggedIn(page) {
  await page.goto(TEMP_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2500)
  const url = page.url()
  const hasComposer = await page.locator('#prompt-textarea, div[contenteditable="true"]').count()
  if (url.includes('/auth/') || url.includes('login') || !hasComposer) {
    const err = new Error('SESSION_DEAD: ChatGPT profile is logged out. Run `make setup-chatgpt`.')
    err.code = 'SESSION_DEAD'
    throw err
  }
}

// Two measurement conditions share this file:
//   ask()        - the DEFAULT buyer view. The model decides for itself whether
//                  to search, and often answers head terms from training data.
//                  Zero citations here usually means "did not search".
//   askSearch()  - the SEARCH-FORCED view, run as its own surface
//                  (chatgpt-app-search). Uses the same ?q= auto-submit hook the
//                  browser search-engine integration uses, with hints=search.
// Keep both untangled: forcing search inside ask() would just rebuild the API
// condition in a browser and erase the finding the default surface exists for.

export async function ask(page, question, { timeoutMs = 180_000 } = {}) {
  // Fresh temporary chat per question: no cross-question contamination.
  await page.goto(TEMP_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.click()
  await composer.fill(question)
  await page.keyboard.press('Enter')

  const last = await waitForAnswer(page, timeoutMs)
  return { text: last, citations: await collectCitations(page) }
}

export async function askSearch(page, question, { timeoutMs = 180_000 } = {}) {
  await page.goto(TEMP_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const composer = page.locator('#prompt-textarea, div[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })

  // Arm the Web search tool from the composer's "+" menu before typing.
  // (?q=&hints=search was tried first and produced unsearched answers - the
  // menu is the path that verifiably works.)
  const plus = page.locator('button[aria-label*="Add" i], [data-testid="composer-plus-btn"]').first()
  if (!(await plus.count())) {
    const err = new Error('SEARCH_UNAVAILABLE: composer "+" menu button not found')
    err.code = 'SEARCH_UNAVAILABLE'
    throw err
  }
  await plus.click({ timeout: 10_000 })
  await page.waitForTimeout(1_500)
  // The menu rows are plain divs (class __menu-item) with no ARIA role, so
  // match by class first and fall back to role/text in case that changes back.
  const menuItemCandidates = [
    page.locator('div.__menu-item').filter({ hasText: /web search/i }),
    page.locator('[role="menuitem"], [role="menuitemradio"]').filter({ hasText: /web search/i }),
    page.getByText(/^web search$/i),
  ]
  let webSearch = null
  for (const loc of menuItemCandidates) {
    const el = loc.first()
    if (await el.count()) { webSearch = el; break }
  }
  if (!webSearch) {
    const err = new Error('SEARCH_UNAVAILABLE: "Web search" item missing from the composer menu')
    err.code = 'SEARCH_UNAVAILABLE'
    throw err
  }
  // Element .click() on these rows silently does nothing (observed live) - a
  // raw mouse click at the row's coordinates is what actually arms the tool.
  const box = await webSearch.boundingBox()
  if (!box) {
    const err = new Error('SEARCH_UNAVAILABLE: "Web search" row has no bounding box')
    err.code = 'SEARCH_UNAVAILABLE'
    throw err
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(1_500)
  await page.keyboard.press('Escape') // the menu stays open after selecting

  // Trust the chip, not the click: only a visible "Web search" pill in the
  // composer counts as armed.
  const chip = await page
    .locator('form')
    .filter({ hasText: /web search/i })
    .count()
  if (!chip) {
    const err = new Error('SEARCH_UNAVAILABLE: clicked "Web search" but no chip appeared in the composer')
    err.code = 'SEARCH_UNAVAILABLE'
    throw err
  }

  await composer.click()
  await composer.fill(question)
  await page.keyboard.press('Enter')

  const last = await waitForAnswer(page, timeoutMs)
  const citations = await collectCitations(page)

  // This surface's one job is the searched answer. Zero citations means search
  // never actually engaged, and storing the row would silently duplicate the
  // default condition.
  if (citations.length === 0) {
    const err = new Error('SEARCH_NOT_ENGAGED: search was armed but the answer has no sources')
    err.code = 'SEARCH_UNAVAILABLE'
    throw err
  }
  return { text: last, citations }
}

// Completion = the stop-streaming control disappears and text stops growing.
async function waitForAnswer(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = '', stableFor = 0
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500)
    const streaming = await page.locator('button[data-testid="stop-button"], button[aria-label*="Stop"]').count()
    const text = await lastAssistantText(page)
    if (text === last && text.length > 0) { stableFor += 1500 } else { stableFor = 0; last = text }
    if (!streaming && stableFor >= 4500 && text.length > 0) break
  }
  if (!last) throw new Error('EMPTY_ANSWER: no assistant text captured')
  return last
}

async function collectCitations(page) {
  // Web-search sources sit behind a control, so an answer that plainly used
  // search still yields zero citations unless it is opened first - the same
  // trap the Perplexity runner hit.
  await revealSources(page)
  return page.evaluate(() => {
    const out = new Map()
    document.querySelectorAll('a[href^="http"]').forEach(a => {
      const href = a.href
      if (href.includes('chatgpt.com') || href.includes('openai.com')) return
      if (!out.has(href)) out.set(href, { url: href, title: (a.textContent || '').trim().slice(0, 200) })
    })
    return [...out.values()]
  })
}

async function revealSources(page) {
  const candidates = [
    page.getByRole('button', { name: /\d+\s+(sources?|sites?|results?)/i }),
    page.getByRole('button', { name: /^sources?$/i }),
    page.locator('[data-testid*="search-sources"], [data-testid*="citation"]'),
  ]
  for (const loc of candidates) {
    try {
      const el = loc.first()
      if ((await el.count()) && (await el.isVisible())) {
        await el.click({ timeout: 5_000 })
        await page.waitForTimeout(2_000)
        return true
      }
    } catch {
      // try the next selector
    }
  }
  return false
}

async function lastAssistantText(page) {
  const nodes = page.locator('[data-message-author-role="assistant"]')
  const n = await nodes.count()
  if (!n) return ''
  return ((await nodes.nth(n - 1).innerText()) || '').trim()
}
