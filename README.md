# geo-tracker

Find out whether AI answer engines mention and cite you when a buyer asks them a question in your category.

Point it at your company, give it a list of questions your buyers actually ask, and every morning it asks those questions across nine surfaces, stores the raw answer and every citation, and keeps a ledger of which domains the engines cite instead of you. That ledger is the useful part. If Reddit and three benchmark blogs are what GPT cites for "best X in 2026", those are the pages worth appearing on, and you no longer have to guess.

We built this at [String](https://usestring.ai) to answer that question about ourselves. It works for any company, so here it is.

## Quickstart

Needs [bun](https://bun.sh) and at least one engine API key.

```sh
git clone https://github.com/durable-alpha/geo-tracker && cd geo-tracker
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

## The bug worth knowing about

For a week our Google AI Overview collector reported a mean of 0.0 citations and scored 48 of 50 questions as "Google showed no AI Overview." Checked by hand in a real browser, 6 of 6 of those questions had one.

The collector was fetching the page and parsing the HTML. Google streams the AI answer in after load, and writes the literal string "An AI Overview is not available for this search" into the pre-generation HTML. Our parser read that correctly and scored a real negative on it. Probed over CDP, the overview container is absent at 1 second and present at 9.

The parser was not the problem. Reading the page that early was. Both Google surfaces now drive a real browser and wait for the answer to settle or for a 30 second deadline to expire. Questions with no overview cost the full timeout, which is deliberate: a fast false negative is the exact bug being fixed.

If you build something like this yourself, that is the failure mode to plan for. A collector that reports zero looks identical to a collector that is working and finding nothing.

## Why the Google surfaces need clean egress

Same story, second half. Running the Google surfaces from an office IP got us rate-limited by name on Google's block page. Failures ran at 11 in 50.

Both Google surfaces now connect to a remote Chrome over CDP with rotating residential egress, through [String's Web Access API](https://usestring.ai), which is our product. Failures went to 1 in 50. The one that remains is honest: Google refuses some queries about defeating CAPTCHA and Cloudflare from any IP, and those rows are stored as errors rather than papered over.

You need a key for this, and you can skip it. The four engine APIs need nothing from us, and the tracker runs fine without the two Google surfaces. Any CDP endpoint with residential egress works; `scripts/surfaces/cdp-session.mjs` is about twenty lines of connection setup. We use ours because we built it and it is what we had.

One note if you go this route: `chromium.connectOverCDP()` from Playwright hangs against our endpoint while `puppeteer.connect()` succeeds in 1.2 seconds. That is a bug on our side, filed. The surfaces use puppeteer-core because of it.

## Storage

SQLite, five tables.

`questions` is the bank. `runs` holds one row per question per surface per day, with the raw answer text and the citation list, and failures stored as rows rather than dropped. `mentions` holds the extraction pass output. `domains` is the citation ledger with a classification per domain. `competitor_pages` holds the URL set behind the sitemap diff.

Extraction is two model passes over the stored answers. Haiku decides whether you were mentioned, at what rank, and with what sentiment. Sonnet classifies any newly seen citation domain. Both are idempotent, so re-running costs nothing on rows already done.

## Cost control

Asking every question across every surface daily is more measurement than the signal justifies. Split the bank instead: tag your highest-value questions `tier:daily` and run those Monday through Saturday with `make run-core`, then run the full bank on Sunday with `make run`. Consumer apps and the competitor diff run weekly.

Every runner resumes. A question answered cleanly today is skipped, so a re-run retries failures and nothing else.

## Two ways to corrupt your own data

Provision the engine keys in a dedicated org, and log the consumer apps in as a dedicated account with memory off and custom instructions cleared. Account history bleeds into answers. Keys attached to your personal account measure how the engines talk to you, not how they talk to a buyer.

`date('now')` in SQLite is UTC, not local. A manual re-run late in the evening reads as a new day and redoes work that already landed.

## Backups

`make backup` snapshots the database to a GitHub release. Point `BACKUP_REPO` at a **private** repo. Release assets inherit repo visibility, so pointing it at a public repo publishes your database: the full question bank, every raw answer, and your citation ledger. Unset, it does nothing.

## Known gaps

`google-ai-mode` counts citations from every link on the page, filtered only for Google's own domains, so its numbers are a slight ceiling rather than a floor. `google-aio` scopes to the AI Overview container and does not share the flaw. Scoping AI Mode the same way is the open follow-up.

Scheduling is not in this repo. We run it from a scheduled task; cron is fine.

## License

MIT. Take it, fork it, point it at your own company.
