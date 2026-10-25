-- Leaving a group, removing someone, and deleting a group (docs/DESIGN.md §6).
--
-- Money is never lost along the way: leaving or removing needs a zero balance (checked by the store under the
-- group's row lock), and a deleted group is only hidden. Its ledger stays, append-only, like everything else.

alter table groups add column deleted_at timestamptz;

-- A deleted group disappears for everyone: it no longer counts as one of "your groups", so row-level security
-- hides it and all its rows.
create or replace function app_group_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select m.group_id from members m join groups g on g.id = m.group_id
  where m.user_id = app_user_id() and m.left_at is null and g.deleted_at is null
$$;

grant update (deleted_at) on groups to eventide_app;
