# Performance and failure: what was measured

Everything here is reproducible: `npm run load` and `npm run crash` (scripts/proof). Both start a fresh
database and run the real API (`packages/api/src/node.ts`, the same app the Worker runs) against Postgres 16.

Measured 2026-10-25 on a 4-core Intel Xeon (2.8 GHz) cloud machine. The server, Postgres and the load generator
all share those 4 cores, so the absolute numbers are a floor, not a ceiling.

## Crash test: 0 lost, 0 duplicated

20 writers each add 40 expenses to one group while the server is killed with `SIGKILL` 15 times at random
moments: mid-request, mid-transaction, after a commit but before the answer is sent. Every writer retries each
request with the same Idempotency-Key until it gets an answer, exactly as the app's outbox does.

| | |
|---|---|
| Expenses sent | 800 |
| Server kills | 15 |
| Retries | ~2,200 |
| Expenses in the ledger | **800**, each exactly once |
| Retries that got a different answer from the first success | **0** |
| Ledger audit (any group whose postings do not sum to zero) | **clean** |

**The test can fail.** With idempotency switched off, it does: a request that committed but whose answer was
lost is retried and refused as a duplicate. So the "committed, answer lost" case really occurs under crashes,
and the Idempotency-Key is what handles it. CI runs a smaller version of this test on every change.

## Load test

Each simulated person loops: 4 in 5 requests read (balances, or the change feed), 1 in 5 adds an expense. People
are in groups of four. Last row: everyone writing to the same group at once.

| Concurrent people | Requests/s | Server CPU ms per request | Read ms p50 / p95 / p99 | Write ms p50 / p95 / p99 | Errors |
|---|---|---|---|---|---|
| 1 (no contention) | 156 | 2.83 | 6 / 9 / 13 | 8 / 12 / 16 | 0 |
| 10, groups of 4 | 444 | 1.87 | 20 / 32 / 39 | 31 / 46 / 55 | 0 |
| 25, groups of 4 | 458 | 1.77 | 49 / 69 / 81 | 72 / 100 / 118 | 0 |
| 50, groups of 4 | 495 | 1.59 | 96 / 122 / 133 | 119 / 149 / 163 | 0 |
| 100, groups of 4 | 561 | 1.46 | 174 / 211 / 227 | 194 / 234 / 255 | 0 |
| 50 in ONE group, writes only | 137 | 2.30 | n/a | 300 / 707 / 1040 | 0 |

8,778 expenses written across the run; ledger audit clean afterwards.

### What it shows

- **The single Node process is the limit here, not Postgres.** Throughput flattens around 450–560 requests/s
  from 10 people up, and latency grows with the queue. During the run the API process used about one full core;
  Postgres about 1.5. On Cloudflare each request runs in its own isolate, so this particular ceiling does not
  carry over. What does carry over is the next point.
- **About 1.5–2.8 ms of server CPU per request.** The Worker free plan allows 10 ms per request, so there is
  roughly a 4–6× margin. (Settle-up's exact search adds at most ~3 ms for 15 people, DESIGN §5.5.)
- **A busy group is limited by its row lock, by design.** Every write to a group takes the group's row lock so the
  change feed has no gaps (DESIGN §7). Throughput for one group is therefore about 1 ÷ (time the lock is held).
  A real flat writes a few times a day; 137 writes a second to one group is far beyond any real use.

### An optimisation, measured before and after

The first version held the group lock for about nine round trips to Postgres per expense. Writes now check
membership first, under share locks on the member rows (concurrent writes can all hold those; leaving the group
has to wait for them), then take the lock, the sequence number and all four inserts in one statement. The lock is
now held for three round trips.

| One busy group, 50 writers | Writes/s | Write ms p50 / p95 |
|---|---|---|
| Before | 95 | 451 / 1,042 |
| After | 131–139 | 307–320 / 681–768 |

About +40%, not the ~3× fewer round trips might suggest: the commit itself, including Postgres flushing its log
to disk, is a large part of what remains. The ordering test (a write held before commit must not let a later one
become visible) and a new race test (someone leaving while an expense naming them is being saved must be refused)
both pass, and each fails when the lock it depends on is removed.

The same change cut a write from about 13 database round trips to about 8, which matters on Hyperdrive's free
plan (100,000 queries a day, DESIGN §11).
