// Claude consumer app runner (claude.ai).
//
// Same shape as chatgpt-app: persistent profile, headed only, one fresh chat
// per question. Anthropic sits behind the same Cloudflare check as OpenAI -
// headless gets "Performing security verification" and never reaches the app -
// so the `headless` argument is accepted and ignored here too.
//
// Isolation: every question runs in an INCOGNITO chat (the ghost icon) -
// claude.ai's equivalent of ChatGPT's temporary chat. Incognito chats are not
// saved to history and do not read or write memory, which kills the two
// contamination paths at the protocol level: nothing from the measurement
// account's past passes can reach an answer, and the passes never accumulate a
// corpus for memory to learn from. ask() asserts the incognito state before
// sending and refuses to measure in a normal chat - the account-settings
// checklist is a belt, this is the braces.
import { chromium } from 'playwright'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PROFILE_DIR = join(ROOT, 'profiles', 'claude')
export const LOGIN_URL = 'https://claude.ai/login'
const NEW_CHAT_URL = 'https://claude.ai/new'
// Both spellings have been observed for the incognito entry point; try the URL
// first (cheapest, most deterministic), then the UI affordances.
const INCOGNITO_URLS = ['https://claude.ai/new?incognito=true', 'https://claude.ai/incognito']

// Selectors are listed most-specific first and are deliberately redundant:
// consumer apps reskin without notice, and a moved selector must degrade into
// a loud failure, never into a silent empty answer.
const COMPOSER = 'div[contenteditable="true"], [data-testid="chat-input"], .ProseMirror'
const STOP_BUTTON = '[data-testid="stop-button"], button[aria-label*="Stop" i]'
const ASSISTANT = '[data-testid="assistant-message"], .font-claude-response, .font-claude-message, div[data-is-streaming="false"]'

export const ACCOUNT_HINT = 'a DEDICATED measurement account, NOT a personal one'
export const SETTINGS_STEPS = [
  'Settings -> Capabilities (or Profile) -> turn MEMORY OFF.',
  'Settings -> Profile -> clear any personal preferences / custom instructions.',
  'Confirm you are in the String workspace if the account has more than one.',
]

export async function launch(_opts = {}) {
  clearStaleLocks()
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  })
}

function clearStaleLocks() {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      rmSync(join(PROFILE_DIR, name), { force: true })
    } catch {
      // never block a launch on lock cleanup
    }
  }
}

// Used by the setup poller. Checks the page the user is already on rather than
// navigating, so it cannot interrupt a login mid-flow.
export async function isLoggedIn(page, ctx) {
  try {
    if (await page.locator(COMPOSER).count()) return true
    const cookies = await ctx.cookies()
    return cookies.some((c) => c.name === 'sessionKey' || /^__Secure.*session/i.test(c.name))
  } catch {
    return false
  }
}

export async function assertLoggedIn(page) {
  await page.goto(NEW_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(3_000)
  const url = page.url()
  const hasComposer = await page.locator(COMPOSER).count()
  if (url.includes('/login') || !hasComposer) {
    const err = new Error('SESSION_DEAD: Claude profile is logged out. Run `make setup-claude`.')
    err.code = 'SESSION_DEAD'
    throw err
  }
}

// Get the page into an incognito chat, or throw. Deliberately multi-strategy
// (URL params, ghost-icon button, keyboard shortcut) because the entry point is
// UI that reskins; deliberately assertion-backed because none of the strategies
// is trusted - only the on-page incognito indicator is.
async function openIncognitoChat(page) {
  for (const url of INCOGNITO_URLS) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(2_000)
      if (await isIncognito(page)) return
    } catch {
      // try the next strategy
    }
  }

  // URL didn't do it - fall back to the UI toggle from a fresh chat.
  await page.goto(NEW_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(2_000)
  const toggles = [
    page.locator('[aria-label*="incognito" i]'),
    page.getByRole('button', { name: /incognito/i }),
    page.locator('a[href*="incognito"]'),
    page.locator('[data-testid*="incognito"]'),
  ]
  for (const loc of toggles) {
    try {
      const el = loc.first()
      if ((await el.count()) && (await el.isVisible())) {
        await el.click({ timeout: 5_000 })
        await page.waitForTimeout(2_000)
        if (await isIncognito(page)) return
      }
    } catch {
      // try the next toggle
    }
  }

  const err = new Error(
    'INCOGNITO_UNAVAILABLE: could not open an incognito chat on claude.ai. ' +
      'Refusing to measure in a normal chat - it would read/write account memory and history. ' +
      'The entry point may have moved; update INCOGNITO_URLS / the toggle selectors in claude-app.mjs.'
  )
  err.code = 'INCOGNITO_UNAVAILABLE'
  throw err
}

// Trust the page, not the navigation: the indicator (ghost styling / explicit
// "incognito" copy in the chat surface) is the only accepted proof.
async function isIncognito(page) {
  try {
    if (/incognito/i.test(page.url())) {
      // URL param accepted only when the app also shows the state.
      const shown = await page
        .locator('text=/incognito/i')
        .first()
        .isVisible()
        .catch(() => false)
      if (shown) return true
    }
    return await page
      .locator('[data-testid*="incognito"], [aria-label*="incognito" i], text=/incognito chat/i')
      .first()
      .isVisible()
      .catch(() => false)
  } catch {
    return false
  }
}

export async function ask(page, question, { timeoutMs = 180_000 } = {}) {
  await openIncognitoChat(page)
  const composer = page.locator(COMPOSER).first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.click()
  // A contenteditable ProseMirror ignores fill(); type into it instead.
  await page.keyboard.insertText(question)
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')

  const deadline = Date.now() + timeoutMs
  let last = ''
  let stableFor = 0
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_500)
    const streaming = await page.locator(STOP_BUTTON).count()
    const text = await lastAssistantText(page)
    if (text === last && text.length > 0) stableFor += 1_500
    else {
      stableFor = 0
      last = text
    }
    if (!streaming && stableFor >= 4_500 && text.length > 0) break
  }
  if (!last) throw new Error('EMPTY_ANSWER: no assistant text captured')

  await revealSources(page)

  const citations = await page.evaluate(() => {
    const out = new Map()
    document.querySelectorAll('a[href^="http"]').forEach((a) => {
      const href = a.href
      if (href.includes('claude.ai') || href.includes('anthropic.com')) return
      if (!out.has(href)) out.set(href, { url: href, title: (a.textContent || '').trim().slice(0, 200) })
    })
    return [...out.values()]
  })

  return { text: last, citations }
}

// Web-search results collapse behind a "Sources"/"N results" control, exactly
// like the Perplexity pill. Without opening it the citation set comes back
// empty even when the answer plainly used search.
async function revealSources(page) {
  const candidates = [
    page.getByRole('button', { name: /\d+\s+(sources?|results?)/i }),
    page.getByRole('button', { name: /^sources?$/i }),
    page.locator('[data-testid*="citation"], [data-testid*="source"]'),
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
  const nodes = page.locator(ASSISTANT)
  const n = await nodes.count()
  if (!n) return ''
  return ((await nodes.nth(n - 1).innerText()) || '').trim()
}
