// One place that knows which consumer-app surfaces exist and how to drive them.
//
// setup-app.mjs, check-app.mjs and run-apps.ts all read from here, so adding a
// surface is one entry rather than three near-identical scripts. The login
// polling in particular was fiddly to get right (see setup-app.mjs); it should
// exist once.
import * as chatgptApp from './surfaces/chatgpt-app.mjs'
import * as claudeApp from './surfaces/claude-app.mjs'
import * as perplexityApp from './surfaces/perplexity-app.mjs'

export const APPS = {
  'chatgpt-app': {
    label: 'ChatGPT',
    surface: chatgptApp,
    // Drives a logged-in consumer session: against OpenAI's terms, so cadence
    // and blast radius are the controls.
    loggedIn: true,
    setupTarget: 'make setup-chatgpt',
    checkTarget: 'make check-chatgpt',
  },
  'claude-app': {
    label: 'Claude',
    surface: claudeApp,
    loggedIn: true,
    setupTarget: 'make setup-claude',
    checkTarget: 'make check-claude',
  },
  'perplexity-app': {
    label: 'Perplexity',
    surface: perplexityApp,
    // Logged out. No account, so no ToS or ban exposure, and no login to set up.
    loggedIn: false,
  },
}

export function requireApp(name) {
  const app = APPS[name]
  if (!app) {
    console.error(`unknown surface "${name}". Known: ${Object.keys(APPS).join(', ')}`)
    process.exit(1)
  }
  return app
}
