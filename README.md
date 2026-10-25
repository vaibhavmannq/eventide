# Eventide

Split shared costs with friends, and settle up in as few payments as possible. Everyone's even by nightfall.

Eventide is a portfolio project about getting an ordinary thing exactly right: money that never drifts by a
penny, many people editing one group at once, phones that go offline, and every reliability claim backed by a
test or a measurement. It runs entirely on free tiers.

**Status:** phases 0 and 1 of 5 are done: the ledger core, and the Postgres database with its write paths. The API
and app are next.
See the [design](docs/DESIGN.md) for the whole plan.

## What's here

| Path | What |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | Requirements, architecture, data model, consistency, scaling, testing |
| [`docs/decisions/`](docs/decisions/) | Why Postgres, why integer money, why an append-only ledger, why these hosts |
| [`docs/DATABASE.md`](docs/DATABASE.md) | Roles, migrations, and the rules Postgres enforces on its own |
| [`packages/ledger`](packages/ledger/src) | The money rules as pure TypeScript: splitting, double-entry postings, balances, settle-up |
| [`packages/db`](packages/db) | Schema, migrations, and every read and write, each in one transaction |
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

## Running it

Needs Node 22 or later.

```bash
npm install
npm test            # unit and property tests
npm run typecheck
npm run check       # Biome lint and format
npm run test:db     # integration tests against Postgres (see docs/DATABASE.md)
node --experimental-strip-types scripts/bench-settle.ts
```
