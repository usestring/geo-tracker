# geo-tracker

Find out whether AI answer engines mention and cite you when a buyer asks them a question in your category.

Point it at your company, give it a list of questions your buyers actually ask, and every morning it asks those questions across nine surfaces, stores the raw answer and every citation, and keeps a ledger of which domains the engines cite instead of you. That ledger is the useful part. If Reddit and three benchmark blogs are what GPT cites for "best X in 2026", those are the pages worth appearing on, and you no longer have to guess.

We built this at [String](https://usestring.ai) to answer that question about ourselves. It works for any company, so here it is.

## Quickstart

Needs [bun](https://bun.sh) and at least one engine API key.

```sh
git clone https://github.com/usestring/geo-tracker && cd geo-tracker
bun install
cp .env.example .env        # set BRAND_NAME, BRAND_DOMAIN, and one API key
```

Edit `questions.csv`, replacing our sample questions with yours. Then:

```sh
make seed        # build data/geo.db from schema.sql + questions.csv
make dry-run     # print what a run would do, no API calls
make run-core    # ask the questions, store the answers
make extract     # decide which answers mentioned you, classify the cited domains
make dashboard   # write data/dashboard.html
```

Open `data/dashboard.html`. That is your position.

## The question bank is the hard part

Everything else here is plumbing. The bank decides whether you learn anything, and a bank of questions you invented at your desk will tell you that you are doing great.

`questions.csv` ships with 15 examples so the format is obvious. We run over 200, specific to our segment and to what we believe our buyers search for. We do not write them from imagination. They come from four places:

**Recorded sales calls.** Every call recording is a transcript of a buyer describing their problem in their own words, before they knew our vocabulary. One pass over those transcripts pulls out what people asked before they found us, the words they use for the problem, and the objections. This is the highest-provenance source we have, and almost nobody mines it.

**Search data.** Google Search Console shows which queries already surface you, including the long tail you never targeted. `make gsc` pulls queries, pages, and index coverage.

**What competitors publish.** Rivals do keyword research too, and their content calendar is public. `make competitors` diffs each competitor's sitemap against the stored URL set and summarises what is new, so you see what they think wins next before that page has earned a single citation.

**Community sentiment.** Reddit, Stack Overflow, Hacker News, and the issue trackers of open source tools in your space, read on a schedule. People describe being blocked, priced out, or stuck in language no keyword tool returns. New vendor names and new problems appear here first.

`docs/question-bank.md` has the full method, including the tagging scheme and the rules that keep trend lines intact.

Two rules matter more than the rest. Additions only: retire a question by setting `active=0` and never delete a row, because ids anchor every trend line. And tag questions by theme and intent from the start, because "are we cited more this month" is a much less useful question than "are we cited more on pricing questions this month."

## What it measures

Nine surfaces, because they disagree with each other and the disagreement is the point.

Four engine APIs, each with web search or grounding on: `gpt` (OpenAI Responses with `web_search`), `claude` (Anthropic Messages with the web search tool), `perplexity` (Sonar), and `gemini` (with `google_search` grounding).

Two Google surfaces driven through a headless browser: `google-ai-mode` (the `udm=50` AI Mode SERP) and `google-aio` (the AI Overview block on a normal SERP).

Three consumer apps driven through a logged-in browser profile, weekly, on a 15-question sample: `chatgpt-app`, `claude-app`, and `perplexity-app`.

The apps are there because the API is not what a buyer sees. Consumer apps run a different retrieval stack, different system prompts, and personalization on top. Measuring only the API assumes that gap is zero. The dashboard reports it instead.

### Three breakdowns, never one score

Every number here breaks down three ways: by engine, by prompt family, and by cited URL. There is no single visibility score, on purpose.

A blended number hides the cause. Losing on Perplexity while holding on GPT is a different problem from losing evenly across all nine, and the fixes point in opposite directions. A whole category of questions can collapse while the average sits still. A citation total means nothing until you know which URL earned it, because that URL is the page you have to displace or get onto.

The tables follow this everywhere: mention and citation rate per surface, the same rates per question category, and a domain ledger keyed on the cited URL.

### The measurement pack

Seven more measurements sit on top of the same data, each behind its own make target and each writing a JSON side-output the dashboard picks up.

`make rank` computes share of voice for you and every competitor in `COMPETITOR_NAMES`, ranks the ladder, and breaks it out per theme and per `prio:` level, trailing 7 days against the 7 before. A brand that appears nowhere is unranked, not last.

`make routing` decides, per theme, whether the work is on-page or off-page. It compares the mention rate when a fact is asked about directly (`type:validation` questions) against the mention rate on the theme's ordinary discovery questions. Engines that know the fact but never surface it are a trust gap, fixed off-page; engines that never learned it are a comprehension gap, fixed on-page. A theme without validation questions gets "no validation coverage", not a guess.

`make objections` clusters the window's negative and inaccurate answers into named objection themes, each with a verbatim quote and a one-line reframe. Zero negative rows writes an empty list; it never invents objections. One Sonnet call, needs `ANTHROPIC_API_KEY`.

`make sentiment` counts positive/neutral/negative/inaccurate per theme over the branded and `type:sentiment` questions, week over week.

`make robots-audit` parses robots.txt properly (RFC 9309 group selection, longest-match path rules) and evaluates 15 AI crawlers against the hosts in `ROBOTS_AUDIT_HOSTS`. A blocked answer-retrieval or search-index crawler is a fault; a blocked training crawler is a policy note. It diffs against the previous audit, so a deploy that flips a rule shows up the next run.

`make weekly-measure` runs all five, each step allowed to fail alone.

Two more read the GSC pulls instead of the answer data. `make opportunity` ranks pages by the clicks a fix would earn - a recover / CTR / rank lever per page, plus near-miss queries - as an ordering, not a forecast. `make edit-enroll URL=... NOTE=...` snapshots a page the day an edit ships; `make edit-read` takes the +28d and +56d readings when due, reporting the control-adjusted lift against the rest of the site, so a rising tide reads as zero. And `make daily-report` renders a one-page daily HTML report: run health per surface, today's mention rate against the 7-day average, and a banner for any surface that produced zero clean rows.

## The bug worth knowing about

For a week our Google AI Overview collector reported a mean of 0.0 citations and scored 48 of 50 questions as "Google showed no AI Overview." Checked by hand in a real browser, 6 of 6 of those questions had one.

The collector was fetching the page and parsing the HTML. Google streams the AI answer in after load, and writes the literal string "An AI Overview is not available for this search" into the pre-generation HTML. Our parser read that correctly and scored a real negative on it. Probed over CDP, the overview container is absent at 1 second and present at 9.

The parser was not the problem. Reading the page that early was. Both Google surfaces now drive a real browser and wait for the answer to settle or for a 30 second deadline to expire. Questions with no overview cost the full timeout, which is deliberate: a fast false negative is the exact bug being fixed.

If you build something like this yourself, that is the failure mode to plan for. A collector that reports zero looks identical to a collector that is working and finding nothing.

## Pin the models you measure

Second failure mode, same shape. Gemini lost 42% of its rows for three days, and nothing in the data said why. The adapter called `gemini-flash-latest`, which is an alias. During a demand spike the alias answered 503 on 5 of 5 probe calls while `gemini-3.5-flash` answered 3 of 3 on the same key in the same minute. An alias also gets re-pointed without notice, so the surface you are measuring can change with no boundary in your data.

The fix has three parts. Pin a concrete model. Keep an ordered fallback list for demand spikes (`GEMINI_MODELS` in `.env`), and verify every fallback actually grounds first: `gemini-3.1-flash-lite` returns HTTP 200 with zero grounding chunks, which would score as "Gemini cited nothing", a false zero instead of a visible outage. And record which model answered in `runs.model_id`, so a swap shows up in the data while the `model` column keeps the surface name and the trend lines intact.

## Why the Google surfaces need clean egress

Same story, second half. Running the Google surfaces from an office IP got us rate-limited by name on Google's block page. Failures ran at 11 in 50.

Both Google surfaces now connect to a remote Chrome over CDP with rotating residential egress, through [String's Web Access API](https://usestring.ai), which is our product. Failures went to 1 in 50. The one that remains is honest: Google refuses some queries about defeating CAPTCHA and Cloudflare from any IP, and those rows are stored as errors rather than papered over.

You need a key for this, and you can skip it. The four engine APIs need nothing from us, and the tracker runs fine without the two Google surfaces. Any CDP endpoint with residential egress works; `scripts/surfaces/cdp-session.mjs` is about twenty lines of connection setup. We use ours because we built it and it is what we had.

One note if you go this route: `chromium.connectOverCDP()` from Playwright hangs against our endpoint while `puppeteer.connect()` succeeds in 1.2 seconds. That is a bug on our side, filed. The surfaces use puppeteer-core because of it.

Expect the egress itself to go stale, and instrument for it. On one run every single question came back a Google traffic challenge, 43 for 43, after weeks at roughly one block in fifty. Nothing in the code had changed. `scripts/probe-google.mjs` sends one request per egress config and prints the exit IP next to what Google served, which separates the two causes that look identical from the outside: a burned IP pool, or a browser fingerprint Google has learned. It measured the premium residential pool at 0 of 7 with a different exit address every time, and the cheaper standard pool at 5 of 6 on the same code. So the pool's reputation was the problem and the fingerprint was fine. Both surfaces now default to the standard tier and the pass recovered the same afternoon.

The general lesson is worth more than the specific tier. A residential pool is shared, so its reputation is not yours alone, and a pool that works today can be flagged tomorrow because of what somebody else did with it. Run the probe before you debug anything else.

And assume the socket opening proves nothing. On one run the endpoint accepted the websocket while the browser behind it was already gone, so the first protocol call hung for puppeteer's default 180-second timeout, and 26 of 50 questions burned three minutes each to learn the same fact. The session layer now makes a real protocol call before handing a session back, runs a 30-second protocol timeout, and stops the pass after three consecutive dead opens. A wedged endpoint should fail in seconds, once.

Run them with `make serp-core` for the daily subset or `make serp` for the full bank. Both resume, so a re-run only retries what failed. `bun scripts/probe-google.mjs` is the first thing to reach for when they start coming back blocked.

## Tests

`make test` runs in about thirty seconds and spends no network and no browser credits. It fakes the hosted browser and reproduces the dead-page condition described above, which is the failure that cost us 126 questions in one pass.

## Storage

SQLite, five tables.

`questions` is the bank. `runs` holds one row per question per surface per day, with the raw answer text, the citation list, and the concrete model that answered (`model_id`), and failures stored as rows rather than dropped. `mentions` holds the extraction pass output. `domains` is the citation ledger with a classification per domain. `competitor_pages` holds the URL set behind the sitemap diff.

Extraction is two model passes over the stored answers. Haiku decides whether you were mentioned, at what rank, and with what sentiment. Sonnet classifies any newly seen citation domain. Both are idempotent, so re-running costs nothing on rows already done.

## Cost control

Asking every question across every surface daily is more measurement than the signal justifies. Split the bank instead: tag your highest-value questions `tier:daily` and run those Monday through Saturday with `make run-core`, then run the full bank on Sunday with `make run`. Consumer apps and the competitor diff run weekly.

Every runner resumes. A question answered cleanly today is skipped, so a re-run retries failures and nothing else. `--force` asks everything again.

The extraction pass runs on Anthropic's Message Batches API, at half price on input and output. Nothing reads its output until the next morning, and a request that expires or gets canceled falls back to a live call, so cheaper never means thinner. The mentions pass also reads at most the first 8,000 characters of an answer; on our data, 12% of calls were hitting the old 24,000-character cap and carried 46% of all input characters, and zero rows had their only brand mention past 8,000. The measurement calls themselves are deliberately not batched: a 2-request batch of grounded Sonnet was still running after 28 minutes, against 80 seconds live.

## Two ways to corrupt your own data

Provision the engine keys in a dedicated org, and log the consumer apps in as a dedicated account with memory off and custom instructions cleared. Account history bleeds into answers. Keys attached to your personal account measure how the engines talk to you, not how they talk to a buyer.

`date('now')` in SQLite is UTC, not local. A manual re-run late in the evening reads as a new day and redoes work that already landed.

## Backups

`make backup` snapshots the database to a GitHub release. Point `BACKUP_REPO` at a **private** repo. Release assets inherit repo visibility, so pointing it at a public repo publishes your database: the full question bank, every raw answer, and your citation ledger. Unset, it does nothing.

## The failure shape to watch for: a clean row with no citations

The blocks and the crashes are the easy failures. They write error rows and you can count them.

The expensive one is quieter. AI Mode is a conversation, not a search page, so asking question after question through the same browser tab makes Google treat them as one thread. The answer text keeps rendering. The source list stops rendering as anchors. The row lands with a real answer, correct mention data, and zero citations, and nothing anywhere reports a problem.

We lost 37 of 49 rows on one pass that way, every one after the thirteenth question, against a historical rate of 0 to 4 percent. Re-asking the same questions on a fresh tab returned 20, 17, 38 and 15 citations. `google-ai-mode` now opens one tab per question, which costs almost nothing next to a reconnect. `google-aio` does not need it and was clean on the same pass.

The general point: when a scraper's output is a count, zero is a value your code will happily store. Check the distribution of that count over time, not just the error rate.

## Known gaps

`google-ai-mode` counts citations from every link on the page, filtered only for Google's own domains, so its numbers are a slight ceiling rather than a floor. `google-aio` scopes to the AI Overview container and does not share the flaw. Scoping AI Mode the same way is the open follow-up.

Scheduling is not in this repo. We run it from a scheduled task; cron is fine.

Alerting is thin. The surfaces write honest error rows, but nothing shouts when a whole surface comes back empty, so a full day of Google data can go missing quietly. Whatever runs this on a schedule should check for a surface whose clean-row count is zero and say so the same day.

## License

MIT. Take it, fork it, point it at your own company.
