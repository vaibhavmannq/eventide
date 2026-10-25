-- transaction_revisions gets its own group_id, like every other ledger table, so row-level security checks the
-- group directly instead of looking the transaction up.
--
-- Why now: a write that inserts the transaction and its first revision in one statement (recordTransaction) was
-- refused, because the old policy's lookup could not yet see the transaction inserted by the same statement.
-- It is also a cheaper check.
--
-- Filling the column in for existing rows is an UPDATE on an append-only table, so the trigger that forbids
-- rewriting is lifted for exactly that statement, in this reviewed migration, and put back.

alter table transaction_revisions add column group_id uuid;

alter table transaction_revisions disable trigger revisions_append_only;
update transaction_revisions r set group_id = t.group_id from transactions t where t.id = r.transaction_id;
alter table transaction_revisions enable trigger revisions_append_only;

alter table transaction_revisions alter column group_id set not null;
alter table transaction_revisions
  add constraint transaction_revisions_group_fk foreign key (group_id, transaction_id)
  references transactions (group_id, id);

drop policy member_of on transaction_revisions;
create policy member_of on transaction_revisions using (group_id in (select app_group_ids()));
