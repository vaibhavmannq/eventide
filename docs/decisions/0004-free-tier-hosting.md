# 0004 — Hosting on free tiers: Cloudflare Workers and Neon

Date: 2026-10-25 · Status: accepted

## Context

The project must cost nothing to run, and should still respond quickly to someone opening it on a phone.

## Options (free allowances as checked on 2026-10-25)

- **Cloudflare Workers.** 100,000 requests a day, 10 ms CPU per request, never sleeps, no card needed.
- **Render.** A free web service, but it sleeps after 15 idle minutes and takes about a minute to wake. Its free
  Postgres expires after 30 days.
- **Fly.io.** No longer has a free allowance, only a trial.
- **Vercel.** Hobby plan is for non-commercial use, and serverless functions only.

## Decision

The API on Cloudflare Workers, the web app on Cloudflare Pages, the database on Neon (ADR 0001).

## Consequences

- 10 ms of CPU per request is a real budget. It is why settle-up's exact search stops at 15 people
  (DESIGN §5.5), and any heavy work has to be measured against it.
- Load tests run against a local stack; hammering production would use up the free allowances.
- To stay portable, the API is plain HTTP and the database is standard Postgres, with no Cloudflare-only storage
  in the core. Moving to a Node server on any host means swapping the entry point, not rewriting the app.
