# Contributing

## Setup

    npm install
    npm start          # api on :5174, ui on :5173

This runs against the bundled sample warehouse (`sample-data/`) -- no
credentials needed. See the README's "Connecting your own source" for
attaching a real one.

## Before opening a PR

    npm run check       # typecheck + unit tests + e2e

All three have to pass. The e2e suite (`e2e/smoke.spec.ts`) expects the dev
server already running (`npm start` in another terminal) -- it does not start
one itself.

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
