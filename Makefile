seed:
	bun scripts/seed.ts

dry-run:
	bun scripts/run-daily.ts --dry-run

# --- engine APIs ------------------------------------------------------------
# run       the full bank across all 4 engine APIs (weekly)
# run-core  only the questions tagged tier:daily (daily)
# retry     re-run only the question/model pairs that failed today
#
# The split is a cost control. Asking 200 questions x 4 engines every day is
# more measurement than the signal justifies; the core subset carries the
# trend and the full bank runs weekly.
run:
	bun scripts/run-daily.ts

run-core:
	bun scripts/run-daily.ts --core

retry:
	bun scripts/run-daily.ts --failed-today

# --- Google surfaces (AI Mode + AI Overviews) -------------------------------
# Both surfaces read String's search endpoint (POST /v1/search, STRING_API_KEY)
# by default. GOOGLE_VIA_BROWSER=1 puts back the hosted-browser path, which
# waits for the streamed answer to settle in a real browser. Same daily/weekly
# split as the engine APIs; both resume, so a re-run only retries failures.
#
# Both surfaces always run. run-apps exits 2 when a surface alerts, and
# without the leading `-` make would stop after google-ai-mode and never ask
# google-aio. Read the ALERT lines in the output, not the exit code.
serp-core:
	-bun scripts/run-apps.ts --only=google-ai-mode --core
	-bun scripts/run-apps.ts --only=google-aio --core

serp:
	-bun scripts/run-apps.ts --only=google-ai-mode
	-bun scripts/run-apps.ts --only=google-aio

# --- tests ------------------------------------------------------------------
# Fakes the hosted browser, so no network and no browser credits are spent.
# These exist because of one incident: a Google page lost its main frame
# mid-pass and the next 126 questions all failed on the same dead frame id.
# The surfaces tracked how OLD a session was and never whether it still
# worked, and reconnecting did not help because the endpoint hands the same
# target back. Both tests reproduce that exact condition.
test:
	bun test tests/

# --- consumer apps (weekly, tier-1 questions only) --------------------------
# The API is not what a buyer sees. Consumer apps run a different retrieval
# stack, different system prompts, and personalization on top.
#
# apps           all three app surfaces
# apps-dry       what it would run, no browser
# apps-check     one question through Perplexity only (logged out, safe)
# setup-*        headed login for the measurement account
# check-*        is that profile still logged in? writes no rows
#
# apps-check is NOT a login check: it exercises the logged-out Perplexity
# surface and passes whether or not a login worked. Use check-chatgpt.
apps:
	bun scripts/run-apps.ts

apps-dry:
	bun scripts/run-apps.ts --dry-run

apps-check:
	bun scripts/run-apps.ts --only=perplexity-app --limit=1

setup-chatgpt:
	bun scripts/setup-app.mjs chatgpt-app

setup-claude:
	bun scripts/setup-app.mjs claude-app

check-chatgpt:
	bun scripts/check-app.mjs chatgpt-app

check-claude:
	bun scripts/check-app.mjs claude-app

# --- output -----------------------------------------------------------------
extract:
	bun scripts/extract.ts

# One ranked list of what to write next, across every kind (new page,
# refresh, queued row): lost answers x prio x coverage verdict, summed per
# page. Needs `make content-coverage` first. Writes data/daily-picks.json.
daily-picks:
	bun scripts/daily-picks.ts

# Competitor posts the engines cite and mention most, grouped by search intent
# and matched to your own page (data/competitor-posts.json). The dashboard's
# priority and "copy this" cards read it. The sitemap fetch tolerates failure.
competitor-posts:
	bun scripts/competitor-posts.ts

dashboard:
	-bun scripts/competitor-posts.ts
	bun scripts/dashboard.ts

# --- measurement pack (rank / routing / objections / sentiment / robots) ----
# Share-of-voice rank vs every competitor, overall / per theme / per prio,
# trailing 7 days against the 7 before. Reads extracted mentions only.
rank:
	bun scripts/visibility-rank.ts

# Validation-x-discovery routing per theme: does the theme need on-page or
# off-page work? Emits "no validation coverage" until type:validation
# questions exist for a theme.
routing:
	bun scripts/routing.ts

# Cluster the window's negative/inaccurate answers into named objection
# themes with a verbatim quote and a reframe each. One Sonnet call; needs
# ANTHROPIC_API_KEY. Zero negative rows writes an empty list.
objections:
	bun scripts/objections.ts

# Sentiment counts + net-positive share per theme over branded and
# type:sentiment questions, week over week.
sentiment:
	bun scripts/sentiment-by-attribute.ts

# Are the AI crawlers allowed into your site? Blocked answer-retrieval or
# search-index crawler = FAULT; blocked training crawler = policy note.
# Diffs against the previous audit and prints CHANGED lines.
robots-audit:
	bun scripts/robots-audit.ts

# The whole measurement pack in sequence. Each step may fail without killing
# the chain - a missing API key must not cost the robots audit.
weekly-measure:
	-$(MAKE) rank
	-$(MAKE) routing
	-$(MAKE) objections
	-$(MAKE) sentiment
	-$(MAKE) robots-audit

# Daily one-page report (HTML): run health per surface, today's non-branded
# mention rate vs the 7d average, new citation domains, and any surface that
# produced zero clean rows. Print data/daily-report.html to PDF with your own
# browser if you want a file to circulate.
daily-report:
	bun scripts/daily-report.ts

# Which of your tracked questions does your own site actually answer? Reads
# the live agent-facing corpus (/llms.txt + .md renditions), so it grades what
# shipped rather than what you meant to ship.
content-coverage:
	bun scripts/content-coverage.ts

# Competitor sitemap diff: fetches each competitor's sitemap, diffs the URL
# list against the stored set, and summarises what is new. Answers what the
# citation data cannot: what did a rival just publish, before that page has
# earned any citations. Set COMPETITORS in .env.
competitors:
	bun scripts/competitor-diff.ts

# --- Google Search Console (optional) ---------------------------------------
# gsc-auth  one-time browser consent (needs GSC_CLIENT_ID/SECRET in .env)
# gsc       queries + pages + query x page + index coverage, CSVs into data/gsc/
gsc-auth:
	bun scripts/gsc.ts auth

gsc:
	bun scripts/gsc.ts queries
	bun scripts/gsc.ts pages
	bun scripts/gsc.ts query-pages
	bun scripts/gsc.ts coverage

# Daily GSC pull for the search feedback loop. Writes to data/gsc/daily/ so
# the weekly scripts' latest-vs-second-latest diffs stay week over week. No
# coverage sweep: that stays weekly.
gsc-daily:
	bun scripts/gsc.ts queries --daily
	bun scripts/gsc.ts pages --daily
	bun scripts/gsc.ts query-pages --daily

# Six action lists from the newest pull -> data/search-feedback.json: low CTR,
# near page 1, losing, new queries, wrong intent, and dead pages that still
# earn impressions. Set SEARCH_BRANDED_TERMS / SEARCH_CATEGORY_TERMS in .env.
search-feedback:
	bun scripts/search-feedback.ts

# Rank pages by the clicks a fix would earn - a recover / ctr / rank lever per
# page against a soft CTR curve, plus near-miss queries. Needs `make gsc`
# pulls. Writes data/opportunity.json; treat it as an ordering, not a forecast.
opportunity:
	bun scripts/opportunity.ts

# Per-edit measurement: enroll a page the day an edit ships, read the +28d and
# +56d numbers when due. The reported number is the control-adjusted lift -
# page clicks change minus rest-of-site clicks change - so a rising tide reads
# as zero. NOTE passes through make and the shell; for notes carrying $ or
# double quotes, call `bun scripts/edit-measure.ts enroll` directly.
edit-enroll:
	bun scripts/edit-measure.ts enroll "$(URL)" --note "$(NOTE)"

edit-read:
	bun scripts/edit-measure.ts read

edit-report:
	bun scripts/edit-measure.ts report

# Snapshot the DB to a release on a PRIVATE repo. No-op unless BACKUP_REPO is
# set. Never point this at a public repo: release assets inherit visibility.
backup:
	./scripts/backup.sh

.PHONY: seed dry-run run run-core retry serp serp-core apps apps-dry apps-check \
        setup-chatgpt setup-claude check-chatgpt check-claude extract dashboard \
        content-coverage competitors gsc-auth gsc backup test \
        rank routing objections sentiment robots-audit weekly-measure daily-report \
        opportunity edit-enroll edit-read edit-report \
        gsc-daily search-feedback competitor-posts daily-picks
