# tests/

`make test` — runs under `bun test`, no network and no hosted browser.

These exist because of one incident. On the Aug 21 full-bank pass a `google-ai-mode`
page lost its main frame after q61, and the next 126 questions all failed on the
same frame id — 75% of the pass, written to the DB as error rows. The surfaces
tracked how OLD a session was and never whether it still worked, and a reconnect
did not help because the hosted endpoint hands the same target back.

Both tests fake the hosted browser, so they reproduce that exact condition
(dead page + reconnect returns the same dead target) without spending browser
credits. `session-recovery.test.mjs` runs ~30s: the surface waits for the answer
text to stop growing, and that wait is the real code path, not a stub.
