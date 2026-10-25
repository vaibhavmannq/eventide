# Eventide

Split shared costs with friends, and settle up in as few payments as possible. Everyone's even by nightfall.

Eventide is a portfolio project about getting an ordinary thing exactly right: money that never drifts by a
penny, many people editing one group at once, phones that go offline, and every reliability claim backed by a
test or a measurement. It runs entirely on free tiers.

**Status:** phases 0–2 of 5 are built and tested: the ledger core, the Postgres database, and the API (sign-in,
groups, invites, expenses, settle-up). Deploying it is the next step ([docs/DEPLOY.md](docs/DEPLOY.md)); the app
comes after.
See the [design](docs/DESIGN.md) for the whole plan.

## What's here

| Path | What |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | Requirements, architecture, data model, consistency, scaling, testing |
| [`docs/decisions/`](docs/decisions/) | Why Postgres, why integer money, why an append-only ledger, why these hosts |
| [`docs/DATABASE.md`](docs/DATABASE.md) | Roles, migrations, and the rules Postgres enforces on its own |
| [`packages/ledger`](packages/ledger/src) | The money rules as pure TypeScript: splitting, double-entry postings, balances, settle-up |
| [`packages/db`](packages/db) | Schema, migrations, and every read and write, each in one transaction |
| [`packages/api`](packages/api) | The HTTP API (Hono) and the Cloudflare Worker that serves it and the app |
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

## Running it

Needs Node 22 or later.

```bash
npm install
npm test            # unit and property tests
npm run typecheck
npm run check       # Biome lint and format
npm run test:db     # integration and API tests against Postgres (see docs/DATABASE.md)

# The Worker locally (real Workers runtime), against a local Postgres:
cp packages/api/.dev.vars.example packages/api/.dev.vars
npm run dev -w @eventide/api
node --experimental-strip-types scripts/smoke.ts http://localhost:8787
node --experimental-strip-types scripts/bench-settle.ts
```
