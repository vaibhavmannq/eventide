# Database

Postgres 16 or later. The schema lives in [`packages/db/migrations`](../packages/db/migrations), one numbered SQL
file per change, applied in order by [`migrate.ts`](../packages/db/src/migrate.ts).

## Roles

| Role | Used by | Can |
|---|---|---|
| The database owner (`neondb_owner` on Neon, `postgres` locally) | Migrations only | Everything, except rewrite ledger history (the append-only triggers stop the owner too) |
| `eventide_app` (no login) | Granted to the API's login role | Read and insert; update only the columns that are meant to change; no `UPDATE` or `DELETE` on `entries`, `transaction_revisions` or `postings`. Row-level security limits it to the current user's groups |
| A login role, e.g. `eventide_api` | The API's connection string | Whatever `eventide_app` can |

The first migration creates `eventide_app`. Create the API's login role once, as the owner, with a password from
your password manager:

```sql
create role eventide_api login password '…';
grant eventide_app to eventide_api;
```

The API sets `app.user_id` at the start of every transaction (`asUser` in
[`connection.ts`](../packages/db/src/connection.ts)); row-level security reads it. When it is not set, the API sees
no groups at all.

## Commands

```bash
DATABASE_URL=postgres://owner@host/db npm run db:migrate   # apply pending migrations, as the owner
npm run test:db                                            # integration tests (needs a Postgres, see below)
```

## Running the integration tests

The tests need a Postgres they may create and drop databases on. They read `DATABASE_URL` and default to
`postgres://postgres@localhost:5432/postgres`. **Never point this at production**: the tests create and drop
databases named `eventide_test_*` and `eventide_template`.

With Docker:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16
npm run test:db
```

How they run: a global setup migrates a template database once, and each test file copies it, which takes
milliseconds. Each file connects twice: as the owner, to check rules that even the owner cannot break, and as
`eventide_api_test` (a member of `eventide_app`), which is what production code gets.

## Rules the database enforces on its own

These hold even if the API has a bug. Each has a test in
[`schema.db.test.ts`](../packages/db/tests/schema.db.test.ts).

- **Double-entry.** A deferred constraint trigger rejects the commit if any entry's postings do not add up to zero
  in each currency.
- **Append-only.** `entries`, `transaction_revisions` and `postings` reject `UPDATE`, `DELETE` and `TRUNCATE`
  from everyone, owner included.
- **Same-group references.** Postings reference `(group_id, member_id)`, so a posting cannot name a member of
  another group.
- **Row-level security.** The API's role sees and writes only rows of groups the current user is an active
  member of.

## Changing the schema

Add a new numbered file. Never edit a migration that has run anywhere: the runner records each migration's
checksum and refuses to run if one changed.
