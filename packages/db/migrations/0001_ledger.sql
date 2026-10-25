-- The ledger: people, groups, transactions as entered, and the append-only postings behind every balance.
-- docs/DESIGN.md §6 and §7. Every rule the money depends on is enforced here as well as in the API, so a bug
-- in the API cannot store an unbalanced or rewritten ledger.

-- The API connects as a login role that is a member of eventide_app (docs/DATABASE.md). This role has only
-- the privileges granted below: in particular, no UPDATE or DELETE on the ledger tables.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'eventide_app') then
    create role eventide_app nologin;
  end if;
end
$$;

-- Who the API is acting for, set per transaction with set_config('app.user_id', ..., true).
-- Unset means nobody, and nobody can see any group.
create function app_user_id() returns uuid
language sql stable
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create table users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique check (email = lower(email) and email like '%_@_%'),
  name       text not null check (length(name) between 1 and 100),
  created_at timestamptz not null default now()
);

create table groups (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(name) between 1 and 100),
  default_currency char(3) not null check (default_currency ~ '^[A-Z]{3}$'),
  -- Bumped under a row lock by every write to the group: the gap-free order of the change feed (§7).
  seq              bigint not null default 0,
  created_by       uuid not null references users (id),
  created_at       timestamptz not null default now()
);

-- A place in a group. Separate from users, so a group can split with someone who has no account yet.
create table members (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references groups (id),
  display_name text not null check (length(display_name) between 1 and 100),
  user_id      uuid references users (id),
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  left_at      timestamptz,
  unique (group_id, user_id),
  -- Lets postings reference (group_id, id), so a posting can never name a member of another group.
  unique (group_id, id)
);
create index members_user on members (user_id) where left_at is null;

-- An expense or a payment, as it stands now. The ledger is entries and postings; this is for reading.
create table transactions (
  id          uuid primary key,  -- made by the app, so an expense created offline has its id already
  group_id    uuid not null references groups (id),
  kind        text not null check (kind in ('expense', 'settlement')),
  revision    integer not null check (revision >= 1),
  deleted     boolean not null default false,
  description text not null default '' check (length(description) <= 200),
  occurred_on date not null,
  currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
  body        jsonb not null,    -- the ledger Transaction as entered: payers and split, or from, to, amount
  created_by  uuid not null references users (id),
  created_at  timestamptz not null default now(),
  updated_by  uuid not null references users (id),
  updated_at  timestamptz not null default now(),
  unique (group_id, id)
);
create index transactions_group on transactions (group_id, occurred_on desc) where not deleted;

-- One row per change: create, edit or delete. Append-only.
create table entries (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null,
  seq            bigint not null,
  kind           text not null check (kind in ('create', 'edit', 'delete')),
  transaction_id uuid not null,
  revision       integer not null,
  created_by     uuid not null references users (id),
  created_at     timestamptz not null default now(),
  unique (group_id, seq),
  unique (group_id, id),
  foreign key (group_id, transaction_id) references transactions (group_id, id)
);

-- Every version a transaction has had, so "what was this before the edit" is always answerable. Append-only.
create table transaction_revisions (
  transaction_id uuid not null references transactions (id),
  revision       integer not null,
  entry_id       uuid not null unique references entries (id),
  deleted        boolean not null,
  description    text not null,
  occurred_on    date not null,
  currency       char(3) not null,
  body           jsonb not null,
  primary key (transaction_id, revision)
);

-- The ledger. A member's balance is the sum of their postings. Append-only.
create table postings (
  id        bigint generated always as identity primary key,
  entry_id  uuid not null,
  group_id  uuid not null,
  member_id uuid not null,
  currency  char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount    bigint not null check (amount <> 0),
  foreign key (group_id, entry_id) references entries (group_id, id),
  foreign key (group_id, member_id) references members (group_id, id)
);
create index postings_entry on postings (entry_id);
-- Balances read only this index: sum(amount) by member and currency for one group.
create index postings_balances on postings (group_id, currency, member_id) include (amount);

-- A retried request takes effect once (§7, step 1). Rows older than a week are deleted by the nightly job.
create table idempotency_keys (
  user_id      uuid not null references users (id),
  key          uuid not null,
  request_hash bytea not null,
  response     jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, key)
);

-- Double-entry (§5.3): when the transaction commits, every entry's postings must add up to zero per currency.
-- Deferred, so all of an entry's postings are inserted before the check runs. Security definer, so row-level
-- security can never hide a posting from the sum and let an unbalanced entry through.
create function check_entry_balanced() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  unbalanced record;
begin
  select currency, sum(amount) as total into unbalanced
  from postings where entry_id = new.entry_id
  group by currency having sum(amount) <> 0
  limit 1;
  if found then
    raise exception 'entry % does not balance: its % postings add up to %',
      new.entry_id, unbalanced.currency, unbalanced.total
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger postings_balanced
  after insert on postings
  deferrable initially deferred
  for each row execute function check_entry_balanced();

-- Append-only (ADR 0003): nobody, not even the owner, updates or deletes ledger history by accident.
-- Doing it on purpose (an erasure request) means dropping this trigger in a reviewed migration.
create function forbid_rewrite() returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end
$$;

create trigger entries_append_only before update or delete or truncate on entries
  for each statement execute function forbid_rewrite();
create trigger revisions_append_only before update or delete or truncate on transaction_revisions
  for each statement execute function forbid_rewrite();
create trigger postings_append_only before update or delete or truncate on postings
  for each statement execute function forbid_rewrite();

-- Row-level security (§9): the API sees only the groups the current user is an active member of. The API
-- checks membership itself as well; this is the second lock, for the day a check is missed.
create function app_group_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp
as $$ select group_id from members where user_id = app_user_id() and left_at is null $$;

alter table groups enable row level security;
alter table members enable row level security;
alter table transactions enable row level security;
alter table entries enable row level security;
alter table transaction_revisions enable row level security;
alter table postings enable row level security;
alter table idempotency_keys enable row level security;

create policy member_of on groups using (id in (select app_group_ids()));
create policy member_of on members using (group_id in (select app_group_ids()));
create policy member_of on transactions using (group_id in (select app_group_ids()));
create policy member_of on entries using (group_id in (select app_group_ids()));
create policy member_of on transaction_revisions
  using (transaction_id in (select id from transactions));
create policy member_of on postings using (group_id in (select app_group_ids()));
create policy own_keys on idempotency_keys using (user_id = app_user_id());

-- Creating a group is the one write where the user is not yet a member, so it runs as the owner and makes
-- the user the group's first member in the same step.
create function create_group(p_name text, p_currency text, p_display_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  creator uuid := app_user_id();
  new_group uuid;
begin
  if creator is null then
    raise exception 'create_group needs app.user_id' using errcode = 'invalid_authorization_specification';
  end if;
  insert into groups (name, default_currency, created_by) values (p_name, p_currency, creator)
    returning id into new_group;
  insert into members (group_id, display_name, user_id, role) values (new_group, p_display_name, creator, 'owner');
  return new_group;
end
$$;

revoke all on function create_group(text, text, text) from public;
revoke all on function app_group_ids() from public;

grant usage on schema public to eventide_app;
grant execute on function app_user_id(), app_group_ids(), create_group(text, text, text) to eventide_app;
grant select, insert on users to eventide_app;
grant update (name) on users to eventide_app;
grant select on groups to eventide_app;
grant update (name, seq) on groups to eventide_app;
grant select, insert on members to eventide_app;
grant update (display_name, left_at) on members to eventide_app;
grant select, insert on transactions to eventide_app;
grant update (revision, deleted, description, occurred_on, currency, body, updated_by, updated_at)
  on transactions to eventide_app;
grant select, insert on entries, transaction_revisions, postings to eventide_app;
grant select, insert, delete on idempotency_keys to eventide_app;
grant update (response) on idempotency_keys to eventide_app;
