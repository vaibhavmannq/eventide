# 0003 — The ledger is append-only

Date: 2026-10-25 · Status: accepted

## Context

People edit and delete expenses. If an edit overwrote the old postings, balances would change with no trace of
why, a lost update would be invisible, and "who changed this" could not be answered.

## Decision

Postings are only ever inserted. An edit appends the reverse of the old postings plus the new ones; a delete
appends the reverse. The `expenses` table holds the current version for fast reading and is updated in the
same transaction, guarded by a revision number (DESIGN §7).

The API's database role has no `UPDATE` or `DELETE` permission on `postings`.

## Consequences

- Full history for free: every balance can be explained line by line.
- The ledger grows with every edit. At about 0.6 KB per change this does not matter (DESIGN §10).
- Removing a person's data (a deletion request) needs a deliberate process that anonymises the member rather
  than deleting postings, so the other members' balances still add up.
