# Contributing

## Setup

    npm ci
    npm start          # api on :5174, ui on :5173

This runs against the bundled sample warehouse (`sample-data/`) -- no
credentials needed. See the README's "Connect a source" for
attaching a real one.

## Before opening a PR

    npx playwright install chromium
    npm run check       # types + result/regression tests + build + browser tests

All checks must pass. Browser tests start isolated servers on ports 5273/5274 and use `.test-data/`. The ordinary preview does not need to be running. Use Node.js 22.12+, 24.x, or 26+.

Each test in `test/corpus.test.ts` and `e2e/smoke.spec.ts` exists because a
specific defect reached a user; if you're fixing a bug, a new test that fails
before your fix and passes after it is the strongest way to show the fix
actually works, and the natural way to explain what broke.

## Code style

- No comments explaining *what* code does -- names should already do that.
  A comment is worth writing only for a non-obvious *why*: a hidden
  constraint, a workaround, something that would surprise a reader.
- No speculative abstractions or unrequested error handling. Match the
  scope of the change to the bug or feature at hand.
- `src/compiler`, `src/connectors`, and `src/semantic` are source-agnostic by
  design -- a change that makes one of them assume a particular adapter or
  connector is almost always a sign it belongs somewhere else.

## Reporting issues

Open a GitHub issue. For anything that touches row-level security or
credential handling, please describe the scenario rather than pasting
real credentials or customer data.

For changes to metric behavior, add an executable reference-result fixture. For editor changes, exercise save/reopen and undo. For AI actions, test malformed, stale, and unsupported proposals without paid model calls. Keep live-provider verification separate and document what was actually exercised.
