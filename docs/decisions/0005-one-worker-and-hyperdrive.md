# 0005 — One Worker for app and API, connected through Hyperdrive

Date: 2026-10-25 · Status: accepted

## Context

The app and the API need a home on Cloudflare's free plan (ADR 0004), a way to reach Neon, and sign-in cookies that
work in every browser.

## Decisions

**One Worker serves both.** `/api/*` reaches the Worker; every other path is a static file from the same Worker
(Workers static assets, free). With the app and API on one origin, the session cookie is first-party. Separate
origins (app on Pages, API on workers.dev) would need cross-site cookies, which Safari blocks and others are
phasing out, plus CORS.

**Hyperdrive, with node-postgres.** Hyperdrive keeps warm, pooled connections to Neon near the database. It
lets the Worker use node-postgres, the driver the tests already run against real Postgres, so production runs
the tested code. `wrangler dev` reaches a local Postgres through the same binding, so the real Workers runtime is
tested locally too (`scripts/smoke.ts`).

The alternative, Neon's serverless driver over WebSockets, has no daily query cap. But it is a second driver that
the tests would not exercise, and each request would open a fresh connection.

**Placement in the database's region.** A write is about a dozen round trips to Postgres and one to the visitor,
so the Worker runs next to the database (`placement.region` in wrangler.jsonc), not next to the visitor.

**Hyperdrive's query cache is off.** It is on by default, keyed on the query text and parameters, and it knows
nothing about row-level security (the user is set per transaction with `set_config`). A balance query cached for
one user could be answered for another with the same group id, and cached reads are not invalidated by writes.
Every read here is a cheap indexed query, so there is nothing worth the risk of caching.

## Consequences

- Hyperdrive's free plan allows 100,000 queries a day, roughly 7,000 writes. If that is ever close, each write
  becomes a single SQL function call (one round trip instead of about thirteen), measured before and after.
- Moving off Cloudflare means swapping `worker.ts` for a Node entry point that builds a `pg.Pool`; `app.ts`, the
  store and the ledger do not change.
