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

# --- Google surfaces (hosted CDP browser, logged out) -----------------------
# Google streams its AI answer in after page load, so neither surface can be
# measured with a fetch snapshot. Both drive a real browser and wait for the
# answer to settle. Same daily/weekly split as the engine APIs; both resume,
# so a re-run only retries failures.
serp-core:
	bun scripts/run-apps.ts --only=google-ai-mode --core
	bun scripts/run-apps.ts --only=google-aio --core

serp:
	bun scripts/run-apps.ts --only=google-ai-mode
	bun scripts/run-apps.ts --only=google-aio

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

dashboard:
	bun scripts/dashboard.ts

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
# gsc       queries + pages + index coverage, CSVs into data/gsc/
gsc-auth:
	bun scripts/gsc.ts auth

gsc:
	bun scripts/gsc.ts queries
	bun scripts/gsc.ts pages
	bun scripts/gsc.ts coverage

# Snapshot the DB to a release on a PRIVATE repo. No-op unless BACKUP_REPO is
# set. Never point this at a public repo: release assets inherit visibility.
backup:
	./scripts/backup.sh

.PHONY: seed dry-run run run-core retry serp serp-core apps apps-dry apps-check \
        setup-chatgpt setup-claude check-chatgpt check-claude extract dashboard \
        content-coverage competitors gsc-auth gsc backup test
