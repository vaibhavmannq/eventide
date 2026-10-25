# Eventide

Split shared costs with friends, and settle up in as few payments as possible. Everyone's even by nightfall.

Eventide is a portfolio project about getting an ordinary thing exactly right: money that never drifts by a
penny, many people editing one group at once, phones that go offline, and every reliability claim backed by a
test or a measurement. It runs entirely on free tiers.

**Status:** live at https://eventide.vaibhavmann-10.workers.dev. Phases 0–4 of 5 are done: the ledger, the
database, the API, the app, and the proof below. A case study on the portfolio is last.

## Proven, not claimed ([docs/PERFORMANCE.md](docs/PERFORMANCE.md))

- **Crash test:** 20 writers, 800 expenses, the server killed with SIGKILL 15 times mid-write: **800 in the
  ledger, 0 lost, 0 duplicated**, and the test does fail if idempotency is switched off. Runs in CI.
- **Load:** 6 ms reads and 8 ms writes (p50) unloaded; about 500 requests/s on 4 shared cores with no errors;
  **1.5–2.8 ms of server CPU per request** against the Worker's 10 ms limit.
- **A measured optimisation:** one busy group went from 95 to about 135 writes/s by holding its lock for three
  round trips instead of nine.

## What's here

| Path | What |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | Requirements, architecture, data model, consistency, scaling, testing |
| [`docs/decisions/`](docs/decisions/) | Why Postgres, why integer money, why an append-only ledger, why these hosts |
| [`docs/DATABASE.md`](docs/DATABASE.md) | Roles, migrations, and the rules Postgres enforces on its own |
| [`packages/ledger`](packages/ledger/src) | The money rules as pure TypeScript: splitting, double-entry postings, balances, settle-up |
| [`packages/db`](packages/db) | Schema, migrations, and every read and write, each in one transaction |
| [`packages/api`](packages/api) | The HTTP API (Hono) and the Cloudflare Worker that serves it and the app |
| [`packages/web`](packages/web) | The app: Preact, about 20 KB of script, installable, offline-first with an outbox |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Putting it online on free tiers, step by step |
| [`scripts/bench-settle.ts`](scripts/bench-settle.ts) | The benchmark that sets how far settle-up searches exactly |

## The ledger in brief

- Amounts are whole numbers of pence or cents, parsed from text, never floats.
- Every split adds up to exactly the total (largest remainder method). £10 three ways is 3.34 + 3.33 + 3.33.
- Every expense becomes double-entry postings that sum to zero, so a group's balances always sum to zero.
- Edits and deletes append reversals; history is never rewritten.
- Settle-up finds the true minimum number of payments for up to 15 people (an NP-hard problem, solved exactly by
  dynamic programming over subsets, 3 ms at p95), and falls back to a greedy n − 1 above that.

Property tests check these rules over thousands of random inputs, including a brute-force check of
settle-up.

## The database in brief

- Postgres checks the money rules again by itself: a deferred trigger refuses to commit any entry whose postings
  don't sum to zero, and the ledger tables refuse `UPDATE` and `DELETE`, even from the owner.
- Row-level security: the API's database role can only see groups the signed-in user belongs to.
- Every write is safe to retry (idempotency keys), and an edit of a stale version is refused, never silently
  overwritten.
- Tested against real Postgres with real concurrent connections: 50 simultaneous writes to one group all land,
  numbered with no gaps; a request sent 20 times at once is applied once; of 10 simultaneous edits, exactly one
  wins.

## The API in brief

- Sign in with GitHub or Google (OAuth with PKCE); the session is a `__Host-` cookie stored only as a hash.
- One Cloudflare Worker serves the API and the app from the same origin, so cookies are first-party and there
  is no CORS.
- Every request is validated against a strict schema, errors have one shape, and changes to money need an
  `Idempotency-Key`. A retry gets back the same bytes.
- Tested with real HTTP requests against Postgres, and on the real Workers runtime with `wrangler dev`.

## The app in brief

- Changes are saved on the device first and sent with their Idempotency-Key when there is a connection, so an
  expense added on a plane is not lost and is never recorded twice.
- Balances and settle-up are computed on the phone with the same ledger code the server uses.
- The moon on each group fills as its debts are settled; full means everyone is even.
- End-to-end tests drive real browsers at phone and laptop sizes against the real Workers runtime: two flatmates
  join by invite, split a dinner and settle up; an expense added offline syncs once; edits and deletes.

## Running it

Needs Node 22 or later.

```bash
npm install
npm test            # unit and property tests
npm run typecheck
npm run check       # Biome lint and format
npm run test:db     # integration and API tests against Postgres (see docs/DATABASE.md)

# The app and the Worker locally (real Workers runtime), against a local Postgres:
cp packages/api/.dev.vars.example packages/api/.dev.vars
npm run dev                # builds the app, serves everything on http://127.0.0.1:8787
npm run e2e                # end-to-end tests in Chromium, phone and laptop sizes
npm run crash              # kill the server mid-write; prove nothing is lost or doubled
npm run load               # throughput, latency and CPU per request at rising concurrency
node --experimental-strip-types scripts/smoke.ts http://localhost:8787
node --experimental-strip-types scripts/bench-settle.ts
```
