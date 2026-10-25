-- Signing in and joining groups (docs/DESIGN.md §9). Tokens are stored only as SHA-256 hashes: someone who reads
-- the database still cannot use a session or an invite link.

create table sessions (
  token_hash bytea primary key,
  user_id    uuid not null references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user on sessions (user_id);

-- No row-level security: a session is looked up before anyone is known, and only ever by its token's hash.
grant select, insert, delete on sessions to eventide_app;

create table invites (
  token_hash bytea primary key,
  group_id   uuid not null references groups (id),
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index invites_group on invites (group_id);

alter table invites enable row level security;
create policy member_of on invites using (group_id in (select app_group_ids()));
grant select, insert, delete on invites to eventide_app;

-- What an invite leads to, for the page that asks "join Flat 4?". The person holding the link is not a member
-- yet, so row-level security would hide the group; this shows only the group's name and the places in it
-- that nobody has claimed, and only for a link that is still valid.
create function invite_preview(p_token_hash bytea)
returns table (group_id uuid, group_name text, unclaimed_member_id uuid, unclaimed_name text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select g.id, g.name, m.id, m.display_name
  from invites i
  join groups g on g.id = i.group_id
  left join members m on m.group_id = g.id and m.user_id is null and m.left_at is null
  where i.token_hash = p_token_hash and i.expires_at > now()
  order by m.joined_at, m.id
$$;

-- Joins the group an invite leads to, either as a new member or by claiming a place someone already made for
-- you ("Sam" was added by name; Sam signs up and becomes that member, keeping the history). Joining twice is
-- harmless. Takes the group's row lock, like every other write to a group.
create function accept_invite(p_token_hash bytea, p_display_name text, p_claim uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  joiner uuid := app_user_id();
  target uuid;
  existing members%rowtype;
begin
  if joiner is null then
    raise exception 'accept_invite needs app.user_id' using errcode = 'invalid_authorization_specification';
  end if;

  select group_id into target from invites where token_hash = p_token_hash and expires_at > now();
  if not found then
    raise exception 'This invite link is not valid' using errcode = 'no_data_found';
  end if;
  perform 1 from groups where id = target for update;

  select * into existing from members where group_id = target and user_id = joiner;
  if found then
    if existing.left_at is not null then
      update members set left_at = null where id = existing.id;
    end if;
    return target;
  end if;

  if p_claim is not null then
    update members set user_id = joiner
      where id = p_claim and group_id = target and user_id is null and left_at is null;
    if not found then
      raise exception 'That place in the group is already taken' using errcode = 'unique_violation';
    end if;
  else
    insert into members (group_id, display_name, user_id) values (target, p_display_name, joiner);
  end if;
  return target;
end
$$;

revoke all on function invite_preview(bytea) from public;
revoke all on function accept_invite(bytea, text, uuid) from public;
grant execute on function invite_preview(bytea), accept_invite(bytea, text, uuid) to eventide_app;

-- The nightly job (docs/DESIGN.md §13). It runs as the API's role, which row-level security limits to one
-- user's groups, so these two run as the owner and do exactly one thing each.

-- Every (group, currency) whose postings do not add up to zero. Must always be empty; if it is not, there is a
-- bug that got past both the API and the trigger.
create function audit_ledger() returns table (group_id uuid, currency char(3), total numeric)
language sql stable security definer set search_path = public, pg_temp
as $$
  select group_id, currency, sum(amount) from postings group by group_id, currency having sum(amount) <> 0
$$;

-- Deletes expired sessions and invites, and idempotency keys older than a week (a retry after a week is a new
-- request). Returns how many of each it deleted.
create function purge_expired() returns table (sessions bigint, invites bigint, idempotency_keys bigint)
language sql volatile security definer set search_path = public, pg_temp
as $$
  with s as (delete from sessions where expires_at < now() returning 1),
       i as (delete from invites where expires_at < now() returning 1),
       k as (delete from idempotency_keys where created_at < now() - interval '7 days' returning 1)
  select (select count(*) from s), (select count(*) from i), (select count(*) from k)
$$;

revoke all on function audit_ledger(), purge_expired() from public;
grant execute on function audit_ledger(), purge_expired() to eventide_app;

-- A retried request must get back exactly the bytes it got the first time. jsonb stores objects in its own key
-- order, so the replay had the same data in a different order; json keeps the text as written. (Found by the
-- end-to-end smoke test, which compares raw responses. 0001 has already run, so it is changed here.)
alter table idempotency_keys alter column response type json using response::json;
