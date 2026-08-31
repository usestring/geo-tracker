# Building the question bank

The tracker is plumbing. The bank is the product. A bank you wrote at your desk will confirm what you already believe, and a tracker pointed at it will produce confident, useless numbers.

This is how we build ours. We run over 200 questions specific to our segment. `questions.csv` in this repo ships 15 of them so the format and tagging are obvious.

## Where questions come from

Four sources, in rough order of how much signal they carry per hour spent.

### Recorded sales calls

The highest-provenance source, and the one almost nobody uses. Every call recording is a buyer describing their problem in their own words, before they learned your vocabulary.

One pass over the transcripts pulls three things: what they searched or asked an LLM before they found you, the words they use for the problem (rarely the words you use), and the objections. A question sourced from a real call is a question you know a buyer asks, which is more than any keyword tool can tell you.

Two standing questions in every customer check-in keep this topped up: "What did you search or ask an LLM when you were looking for this?" and "What guide do you wish existed?"

### Search data

Google Search Console shows queries that already surface you, including a long tail you never targeted. `make gsc` pulls queries, pages, and index coverage into `data/gsc/`.

Search data tells you about demand that already reaches you. It is weakest exactly where you most need help, on questions where you do not appear at all. Do not build the bank from it alone.

### What competitors publish

Rivals run keyword research too, and their conclusions are public in their content calendar.

`make competitors` fetches each competitor's sitemap, diffs the URL list against the stored set, and summarises what is new. It answers a question the citation data cannot: what did a rival just publish, before that page has earned any citations.

One practical note. Read sitemap roots from `robots.txt`, never a guessed `/sitemap.xml`. Some vendors serve theirs from an obfuscated filename and return a 200 HTML "not found" page for the obvious path. Guessing silently returned zero pages for three of eight competitors on our first run, which reads exactly like "they published nothing."

### Community sentiment

Reddit, Stack Overflow, Hacker News, and the issue trackers of open source tools in your space, read on a schedule.

People describe being blocked, priced out, or stuck in language no keyword tool returns. New vendor names show up here first, and so do new problems. Watch the issue trackers in particular: a new issue is a pain phrasing written by someone in the middle of the pain.

We run this every two weeks over a 14 day window, seeded with keyword groups rather than exact matches: use cases, buying and hiring language, blocking, scale and pricing, and vendor sentiment. Seeds are clustering starters, not filters.

## Tagging

Tag from the start. "Are we cited more this month" is a much weaker question than "are we cited more on pricing questions this month," and you cannot retrofit the second one.

Five axes, all in the `tags` column, semicolon separated:

`intent` is its own column: `shortlist` (buyer choosing from a list), `howto` (buyer solving a problem), `comparison` (buyer evaluating claims).

`theme:` groups by subject matter. Ours are `category`, `blocking`, `ai-data`, `scale-pricing`, `compliance`, `data-jobs`, and `brand`. Yours will differ. Keep the list short enough that every question has an obvious home.

`cat:` groups by page type that would answer it: `comparison`, `feature`, `use-case`, `company`. This is the bridge from measurement to what to write.

`tier:daily` marks the questions worth asking every day. Everything else runs on the weekly full pass. This is the cost control, and it should be your highest-value questions, not a random sample.

`prio:1|2|3` weights a question by how central its subject is to the buyer's consideration decision. `prio:1` is the core of why anyone buys in your category, `prio:2` is supporting, `prio:3` is peripheral (brand curiosity, legal questions). `make rank` breaks share of voice out per level, so a slide on `prio:1` questions never hides behind a gain on `prio:3` ones.

`type:` classifies what a question diagnoses. Untyped questions are **discovery** questions — the default, "does the engine bring us up unprompted". The typed ones: `type:validation` asks the engine directly about a fact you want it to know ("Does X support Y?"); `type:sentiment` asks how you are perceived ("X reviews — is it legit?"); `type:market-perception` probes how the category itself is described; `type:competitor` asks about a rival by name; `type:accuracy` marks questions where a factual claim of yours should surface, so wrong answers can be caught. `make routing` needs at least one `type:validation` question per theme to compute that theme's validation score; until then it reports "no validation coverage" rather than guessing.

## Rules that keep the data honest

**Additions only.** Never delete a row and never rewrite an existing question's text. Ids anchor every trend line. Retire a question by setting `active=0`.

**Dedupe on meaning, not string match.** "How do I get past Cloudflare" and "How do I bypass Cloudflare when scraping" are one question. Two rows split the signal and neither trends.

**Cap the bank.** Ours stops at 200. An unbounded bank grows until the daily cost forces a cut, and the cut is made under time pressure by whoever notices the bill.

**Include questions you expect to lose.** A bank tuned to where you already win measures nothing. Roughly a third of ours are questions where we did not expect to appear, and those are the ones that changed what we published.

**One brand-accuracy probe.** Include at least one question that asks what your product is. You are not measuring visibility there, you are measuring whether the engines describe you correctly. They frequently do not, and that is worth knowing before a buyer reads it.

## Cadence

The bank should change slowly. We propose additions monthly, capped at 10 per round, each with the source, the hit count, and two verbatim quotes with links. Anything without evidence does not go in.

Theme drift is a finding even when no question changes. New vendor names entering shortlist threads, month-over-month shift in which themes dominate, and movement in how a competitor gets described are all worth writing down even in a month where the bank stays still.
