# 0001 — Postgres is the source of truth

Date: 2026-10-25 · Status: accepted

## Context

The data is money. It needs transactions across several tables (an expense, its ledger entry, its postings,
the idempotency record), constraints the database enforces on its own, and row locks for ordering
(DESIGN §7). It also has to be free to host (ADR 0004).

## Options

- **Postgres (Neon).** Full transactions, constraint triggers, row-level security, row locks. The free tier never
  expires. Standard SQL, so any Postgres host works.
- **Cloudflare D1 (SQLite).** Free and close to Workers, but no row-level security and no deferred constraints,
  and newer free-plan caps fail queries outright once a daily limit is hit.
- **Durable Objects, one per group.** Writes in a group are naturally serialised and live updates come for free.
  But it ties the core data model to one vendor, and queries across groups (the audit, "all my groups") get hard.
- **Supabase.** Also Postgres, but free projects pause after a week without activity.

## Decision

Postgres on Neon. The database enforces the ledger's rules itself, so a bug in the API cannot store an
unbalanced ledger.

## Consequences

- The first request after five idle minutes waits for Neon to wake.
- Workers reach Neon over HTTPS with Neon's serverless driver; writes go as one transaction per request.
- Durable Objects stay an option for live updates later, alongside Postgres, not instead of it.
