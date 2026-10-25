# Eventide — design

Status: draft, 2026-10-25. The ledger core (§5) is built and tested; everything after it is the plan.

---

## 1. What it is

Eventide splits shared costs between people: flatmates, a trip, a dinner. Someone pays, the app records who owes
what, and at the end it says who should pay whom so that everyone is even, in as few payments as possible.

Splitwise and others already do this. The point of Eventide is not a new idea but a careful build of an
ordinary one: money that is always exactly right, many people editing the same group at once, phones that go
offline, and every claim about reliability backed by a test or a measurement.

## 2. Goals and non-goals

**Goals**

1. **Money is never wrong.** No rounding drift, no lost pennies, no balance that cannot be explained line by line.
2. **Concurrent edits are safe.** Two people adding expenses to the same group at the same moment both land.
   Two people editing the *same* expense do not silently overwrite each other.
3. **Retries are safe.** A phone on a bad connection can resend any request and it takes effect once.
4. **Works offline.** Add an expense on a plane; it syncs when you land.
5. **Costs nothing to run.** Every service on a free tier (§11), and portable enough to leave any of them.
6. **Proven, not claimed.** Load, concurrency and crash tests with published numbers (§12).

**Non-goals (for now)**

- Moving real money. Eventide records that Sam paid Alex back; it does not move the money.
- Automatic currency conversion (§5.6).
- Bank or receipt import.
- Native apps. It is an installable web app (PWA).

## 3. Requirements

**Functional**

- Sign in with Google or GitHub.
- Create a group, invite people by link, add members who have no account yet (they can claim their place later).
- Add an expense: amount, currency, who paid (one or several people), how it is split (equally, exact amounts,
  percentages, or shares).
- Edit or delete an expense; see its history.
- Record a payment between two members.
- See balances, and a suggested set of payments to settle up.

**Non-functional**

| | Target | How it will be checked |
|---|---|---|
| Correctness | Every group's balances add up to zero in every currency, always | Property tests (§5), a database constraint (§5.3), and a nightly audit query (§13) |
| Duplicate writes | 0 under retries and crashes | Crash test: kill the API mid-write, retry with the same key (§12) |
| Lost updates | 0 under concurrent edits | Concurrency test: many clients, one group (§12) |
| API latency | p95 under 300 ms for reads and writes from Europe | k6 against a local stack; spot checks against production |
| Settle-up CPU | under 10 ms (the Worker free-plan limit) | Benchmark (§5.5) |

## 4. Architecture

```mermaid
flowchart LR
  subgraph Phone or laptop
    UI[Web app, PWA]
    IDB[(IndexedDB:<br/>local copy + outbox)]
    UI <--> IDB
  end
  UI -- HTTPS JSON --> API[API on Cloudflare Workers]
  API -- SQL over HTTPS --> DB[(Neon Postgres)]
  API --> Ledger[[@eventide/ledger<br/>pure TypeScript]]
  UI --> Ledger
  Cron[Workers cron: nightly audit] --> DB
```

- **`@eventide/ledger`** (`packages/ledger`) — the money rules: splitting, postings, balances, settle-up. Pure
  functions with no I/O, used by both the API and the app, so a preview on the phone and the stored result
  are computed by the same code.
- **API** — a stateless Worker. It authenticates the request, checks the person belongs to the group, runs the
  ledger rules, and writes in one database transaction. No state lives in the Worker between requests.
- **Postgres** — the single source of truth. It enforces the money rules a second time (§5.3), so a bug in the
  API cannot write an unbalanced ledger.
- **Web app** — keeps a local copy of each group and an outbox of changes not yet sent (§8).

Why these pieces: [ADR 0001](decisions/0001-postgres-as-source-of-truth.md) and
[ADR 0004](decisions/0004-free-tier-hosting.md).

## 5. The ledger

### 5.1 Money

Amounts are whole numbers of the currency's smallest unit: £12.30 is `1230`, ¥1500 is `1500`, 1.234 KWD is
`1234`. Text is parsed digit by digit, never through a float (`"0.29"` is 29, not 28.999…). More decimals than
the currency has is an error, not a rounding. Amounts must be safe integers (below 2^53).
[ADR 0002](decisions/0002-integer-minor-units.md).

### 5.2 Splits

An expense keeps the split *as the person entered it* (`equal`, `exact`, `percent` in basis points, `shares`),
and the amounts are derived from it. That way an edit shows "split equally between 3", not three numbers.

Every split goes through one allocation function (`allocate.ts`), the largest remainder method: everyone gets
the floor of their exact share, and the units left over go one each to the largest remainders. The parts always
add up to the total, and each is within one unit of its exact share. Members are sorted first, so the order the
app sent them in never decides who pays the odd penny.

Known trade-off: the odd penny goes to the same person (by id) on equal splits. Over hundreds of expenses that is
pennies; rotating it would make a split depend on history, which is worse.

### 5.3 Double-entry postings

Each transaction (expense or payment) becomes **postings**: one per member, what they paid minus what they owe.

```
Alex pays £90 dinner, split equally between Alex, Priya, Sam
  alex   +60.00
  priya  -30.00
  sam    -30.00
         ------
           0.00
```

Postings for one transaction always add up to zero per currency. Money only moves between members, so a
group's balances (the sum of each member's postings) always add up to zero too. That is the invariant everything
else protects.

It is checked twice: in TypeScript before writing (`assertBalanced`), and in Postgres by a deferred constraint
trigger that rejects the commit if any transaction's postings do not sum to zero (§6). Postings can be inserted
but never updated or deleted; the database role the API uses does not have those permissions.

### 5.4 Edits and deletes never rewrite history

Editing an expense appends the reverse of its old postings and then its new ones; deleting appends only the
reverse. Nothing is updated in place, so any balance can be explained line by line and "who changed this, and
from what" is always answerable. [ADR 0003](decisions/0003-append-only-ledger.md).

### 5.5 Settling up

Given a group's balances in one currency, find payments that bring everyone to zero, as few as possible.

- Any n people with non-zero balances can settle in n − 1 payments (pay the largest debt to the largest credit,
  repeat; each payment clears at least one person).
- It can do better when the group splits into subgroups whose balances already cancel: a subgroup of k needs only
  k − 1. So the minimum is **n minus the largest number of zero-sum subgroups**.
- Finding that is NP-hard in general (it contains subset-sum), so `settleUp` searches it exactly with dynamic
  programming over subsets (2^n × n steps) for up to 15 people with non-zero balances, and uses the greedy method
  above that.

Example where it matters: balances −10, −9, +4, +9, +6. Greedy takes 4 payments; the exact search sees that
−9 and +9 cancel and takes 3.

The limit of 15 is measured, not guessed (`scripts/bench-settle.ts`, Node 22, cloud Xeon 2.8 GHz,
2026-10-25):

| People with a balance | median | p95 |
|---|---|---|
| 12 | 0.32 ms | 0.39 ms |
| 14 | 1.38 ms | 1.55 ms |
| **15** | **2.80 ms** | **3.09 ms** |
| 16 | 5.51 ms | 6.96 ms |
| 18 | 23.89 ms | 33.17 ms |

15 leaves about 3× headroom under the Worker's 10 ms CPU limit; 16 does not. To re-check on Workers itself once
the API exists.

Tests check, over thousands of random inputs: every suggestion clears every balance, uses at most n − 1 positive
payments, is never worse than greedy, and matches a brute-force search over every partition for small groups.

**Trade-off to surface in the app:** minimal payments can ask Sam to pay Priya even though Sam only ever owed
Alex. That is correct, but can surprise people, so the app will explain it.

### 5.6 Currencies

Balances are kept per currency and never mixed. Converting needs an exchange rate and a moment to take it from;
the app may offer "settle this in GBP at today's rate" later, recorded as an explicit conversion transaction
with the rate stored, never as a silent recalculation.

## 6. Data model

```sql
users        (id uuid pk, email text unique, name text, created_at)
groups       (id uuid pk, name text, default_currency char(3), seq bigint not null default 0, created_at)
members      (id uuid pk, group_id fk, display_name text, user_id uuid null fk,  -- null: no account yet
              role text, joined_at, left_at)
expenses     (id uuid pk, group_id fk, revision int, deleted boolean,         -- the current state, for reading
              description text, occurred_on date, currency char(3), total bigint,
              paid_by jsonb, split jsonb, created_by fk, updated_at)
entries      (id uuid pk, group_id fk, seq bigint, kind text,                 -- one per ledger event, append-only
              expense_id uuid null, revision int null, created_by fk, created_at,
              unique (group_id, seq))
postings     (entry_id fk, group_id fk, member_id fk, currency char(3), amount bigint)  -- append-only
idempotency  (user_id, key uuid, request_hash bytea, response jsonb, created_at, primary key (user_id, key))
invites      (token_hash bytea pk, group_id fk, expires_at, created_by)
sessions     (id_hash bytea pk, user_id fk, expires_at)
```

- **`members` is separate from `users`** so you can split with someone before they sign up.
- **`postings` is the ledger; `expenses` is a convenience view of the latest version.** Both are written in the
  same transaction.
- **Balances** start as `select member_id, currency, sum(amount) from postings where group_id = $1 group by …`
  on an index over `(group_id)`. A group with ten thousand postings sums in well under a millisecond. If the load
  test says otherwise, a `balances` table updated in the same transaction is the next step, not before.
- Tokens (sessions, invites) are stored hashed, so a database leak does not hand out working links.

## 7. Writes: consistency and concurrency

Every write is one Postgres transaction:

1. **Idempotency.** The client sends an `Idempotency-Key` (a UUID made when the user pressed Save). The first
   statement inserts it; if it already exists with the same request hash, the stored response is returned and
   nothing else runs. Same key, different body: rejected. A retried request therefore takes effect once, even
   if the first attempt's response was lost.
2. **Ordering.** `update groups set seq = seq + 1 where id = $1 returning seq` gives the entry a per-group sequence
   number. This row lock also serialises writes *within one group*, which is what makes the change feed (§8)
   gap-free. Different groups never wait on each other. One group sees a few writes a minute, so the lock costs
   nothing in practice. The concurrency test (§12) measures it.
3. **Edits are optimistic.** The client sends the revision it edited. `update expenses set revision = revision + 1
   where id = $1 and revision = $2`; zero rows updated means someone else got there first, and the API returns
   409 with the current version so the app can show both.
4. **Postings are inserted**, and the deferred trigger checks they balance at commit.

Adding expenses never conflicts: postings only add up, and addition does not care about order.

Why the per-group sequence and not a global `bigserial`: sequence values are handed out at insert time but
become visible at commit time, so a reader can see 12 and 14 before 13 commits, store "seen up to 14", and miss
13 forever. A counter bumped under a row lock commits in order.

## 8. Offline and sync

- The app keeps each group in IndexedDB and shows it instantly, online or not.
- Changes go into an **outbox**, each with its idempotency key, and are sent in order when there is a connection.
  Sending twice is harmless (§7).
- The app pulls `GET /groups/:id/changes?after=<seq>` and applies entries in order. `seq` is gap-free per group,
  so "after" never skips anything.
- Offline adds always merge cleanly. Offline edits to an expense someone else also edited come back as a 409
  conflict, shown to the person to resolve: two versions of a money record should not be merged by a rule.
- Updates arrive by polling on focus and every 30 seconds while open. Live push (WebSockets through Durable
  Objects) is possible later but not needed to be correct.

## 9. Security and privacy

- **Sign-in:** OAuth with Google or GitHub; no passwords stored. Sessions are random tokens in an `HttpOnly`,
  `Secure`, `SameSite=Lax` cookie, stored hashed, revocable.
- **Authorisation:** every query that touches a group goes through one function that first checks membership.
  As a second layer, Postgres row-level security restricts rows to groups the current user belongs to (the
  API sets the user id per transaction), so a missed check in the API still cannot read another group.
- **Invites:** 128-bit random tokens, stored hashed, expiring, revocable.
- **Input:** every request body is validated against a schema before it reaches the ledger.
- **Data kept:** name, email, and what you enter. No analytics trackers.

## 10. Capacity and scaling

Eventide will not have a million users; the point is to know where it would break. Back of the envelope for
1 million registered users:

| | Estimate |
|---|---|
| Daily active (20%) | 200,000 |
| Writes | 2 per active user per day → 400,000/day → ~5/s average, ~50/s at a 10× peak |
| Reads | 20 per active user per day → 4 million/day → ~46/s average, ~500/s at peak |
| Storage | ~0.6 KB per expense with its postings and indexes → ~90 GB/year |

One Postgres instance handles that write rate easily; reads are cheap indexed sums. In order, the scaling steps
would be: a `balances` table if summing gets slow; read replicas for reads; and, much later, partitioning by
`group_id`. Groups are independent, so they partition cleanly. Each step waits for a measurement that says it is
needed.

## 11. Running it for free

| Service | Free allowance (checked 2026-10-25) | Eventide's use |
|---|---|---|
| Cloudflare Workers | 100,000 requests/day, 10 ms CPU per request, no card | API; roughly 5,000 sessions a day |
| Cloudflare Pages | Static hosting | The web app |
| Neon Postgres | 0.5 GB storage (1 GB per recent reports), 100 compute-hours/month, sleeps after 5 idle minutes | The database: roughly 800,000 expenses |
| GitHub Actions | Free for public repositories | CI, with Postgres as a service container |

Limits to know about:

- When Neon hits a monthly limit it suspends the database until the next month. Load tests therefore run against
  a local Postgres, never production.
- The first request after five idle minutes waits for Neon to wake (well under a second).
- Free tiers change. The code uses standard Postgres and plain HTTP so moving provider is a configuration
  change. [ADR 0004](decisions/0004-free-tier-hosting.md).

## 12. Testing, and proving the claims

| Layer | What | Status |
|---|---|---|
| Ledger | Unit tests and property tests (fast-check): splits add up, postings balance, settle-up clears everything and matches brute force | Done |
| Database | Integration tests against real Postgres: the zero-sum trigger rejects bad writes, postings cannot be updated | Phase 1 |
| API | Request-level tests: auth, membership checks, idempotency, 409 on stale edits | Phase 2 |
| Concurrency | 50 clients writing to one group at once; afterwards every balance sums to zero and every write is present exactly once | Phase 4 |
| Crashes | Kill the API process mid-write repeatedly, retry with the same keys; count duplicates and losses (target: 0 and 0) | Phase 4 |
| Load | k6 against a local stack: requests/second and p95 latency at increasing load | Phase 4 |
| App | Playwright: add, edit, settle, and the offline outbox | Phase 3 |

## 13. Operations

- Structured JSON logs with a request id on every line.
- Latency and error rate per route.
- **Nightly ledger audit** (Workers cron): `select group_id, currency from postings group by 1, 2 having sum(amount)
  <> 0` must return nothing. If it ever does, that is a bug worth waking up for.

## 14. Plan

| Phase | What | Done when |
|---|---|---|
| 0 | Design, ledger core | Tests pass, this document reviewed |
| 1 | Database schema, migrations, integration tests | Trigger and permissions proven by tests |
| 2 | API: auth, groups, members, expenses, payments, settle-up, change feed | Deployed to Workers, talking to Neon |
| 3 | Web app: installable, offline outbox | Usable on a phone |
| 4 | Concurrency, crash and load tests | Numbers published in the README |
| 5 | Case study card on the portfolio | Live |

## 15. Open questions

- Frontend framework: plain TypeScript like the portfolio, or a small framework (Svelte, Preact) for the forms.
- Whether Cloudflare's rate limiting is usable on the free plan, or a per-user counter in Postgres is needed.
- Placeholder members claiming their place: by invite link only, or also by matching email.
