# Eventide

Split shared costs with friends, and settle up in as few payments as possible. Everyone's even by nightfall.

Eventide is a portfolio project about getting an ordinary thing exactly right: money that never drifts by a
penny, many people editing one group at once, phones that go offline, and every reliability claim backed by a
test or a measurement. It runs entirely on free tiers.

**Status:** phase 0 of 5. The ledger core is built and tested; the API and app are next.
See the [design](docs/DESIGN.md) for the whole plan.

## What's here

| Path | What |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | Requirements, architecture, data model, consistency, scaling, testing |
| [`docs/decisions/`](docs/decisions/) | Why Postgres, why integer money, why an append-only ledger, why these hosts |
| [`packages/ledger`](packages/ledger/src) | The money rules as pure TypeScript: splitting, double-entry postings, balances, settle-up |
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

## Running it

Needs Node 22 or later.

```bash
npm install
npm test            # unit and property tests
npm run typecheck
npm run check       # Biome lint and format
node --experimental-strip-types scripts/bench-settle.ts
```
