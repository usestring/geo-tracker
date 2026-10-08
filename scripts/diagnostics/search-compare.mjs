// Does String's /v1/search see the same Google answers the hosted browser saw?
// Asks the daily-core questions through engine "google" (AI Overview) and
// "google_ai_mode", and prints each beside the browser row stored for --date.
// The question that matters is AI Overview presence: the Aug 12 fetch path
// called 48 of 50 overviews absent when they were there. Writes no rows.
//   set -a && source .env && set +a && bun scripts/diagnostics/search-compare.mjs --date=2026-09-29 --n=58
import { Database } from 'bun:sqlite'
import { searchGoogle } from '../surfaces/google-search.mjs'
const argOf = (n) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1]
const DATE = argOf('date') ?? new Date().toISOString().slice(0, 10)
const N = Number(argOf('n') ?? 20)
const db = new Database(new URL('../../data/geo.db', import.meta.url).pathname, { readonly: true })
const qs = db.query(`SELECT id, text FROM questions WHERE active=1 AND tags LIKE '%tier:daily%' ORDER BY id LIMIT ?`).all(N)
const row = db.query(`SELECT serp_state, json_array_length(citations) n, error FROM runs WHERE question_id=? AND model=? AND date(run_ts)=? ORDER BY (error IS NULL) DESC, id DESC LIMIT 1`)

const tally = { aio: { both: 0, searchOnly: 0, browserOnly: 0, neither: 0, browserErr: 0, searchErr: 0 }, aim: { ok: 0, err: 0, cites: 0, browserCites: 0, browserOk: 0 } }
let aioCites = 0, aioBrowserCites = 0
const lines = []
async function one(q) {
  const [aio, aim] = await Promise.all([
    searchGoogle(q.text, 'google').catch(e => ({ error: e.message })),
    searchGoogle(q.text, 'google_ai_mode').catch(e => ({ error: e.message })),
  ])
  const b1 = row.get(q.id, 'google-aio', DATE), b2 = row.get(q.id, 'google-ai-mode', DATE)
  const bPresent = b1 && !b1.error ? b1.serp_state === 'answer' : null
  if (aio.error) tally.aio.searchErr++
  else if (bPresent === null) tally.aio.browserErr++
  else {
    const s = aio.serpState === 'answer'
    tally.aio[s && bPresent ? 'both' : s ? 'searchOnly' : bPresent ? 'browserOnly' : 'neither']++
    if (s && bPresent) { aioCites += aio.citations.length; aioBrowserCites += b1.n }
  }
  if (aim.error) tally.aim.err++
  else { tally.aim.ok++; if (b2 && !b2.error) { tally.aim.browserOk++; tally.aim.cites += aim.citations.length; tally.aim.browserCites += b2.n } }
  lines.push(`q${q.id}\taio search=${aio.error ? 'ERR ' + aio.error.slice(0, 40) : aio.serpState + '/' + aio.citations.length} browser=${b1 ? (b1.error ? 'ERR' : b1.serp_state + '/' + b1.n) : '-'}\taim search=${aim.error ? 'ERR ' + aim.error.slice(0, 40) : aim.citations.length} browser=${b2 ? (b2.error ? 'ERR' : b2.n) : '-'}`)
}
const queue = [...qs]
await Promise.all(Array.from({ length: 5 }, async () => { while (queue.length) await one(queue.shift()) }))
console.log(lines.sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1))).join('\n'))
console.log('\nAI Overview presence (search vs browser, questions with a clean browser row):', tally.aio)
console.log(`  cites where both saw an overview: search ${aioCites}, browser ${aioBrowserCites}`)
console.log('AI Mode:', tally.aim)
