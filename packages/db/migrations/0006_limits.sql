-- Limits per person (docs/DESIGN.md §11, packages/db/src/limits.ts). Sign-up is open, and every free allowance
-- (Neon's storage, Hyperdrive's queries) is shared by everyone, so no one account may use more than a person
-- splitting costs ever would. Real use is a few dozen changes a day; these are hundreds of times that.
--
-- Activity is counted here, as the owner, because row-level security would hide what matters: changes in groups
-- the person has since deleted or left. Otherwise "fill a group, delete it, start another" would never be counted.

create index entries_by_person on entries (created_by, created_at);
create index groups_by_creator on groups (created_by, created_at);

create function my_activity_today(out changes bigint, out groups_started bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  select
    (select count(*) from entries where created_by = app_user_id() and created_at > now() - interval '1 day'),
    (select count(*) from groups where created_by = app_user_id() and created_at > now() - interval '1 day')
$$;

revoke all on function my_activity_today() from public;
grant execute on function my_activity_today() to eventide_app;

-- Joining through an invite link counts towards a group's limit on people, like adding someone by name does
-- (limits.ts, peoplePerGroup: keep the two numbers the same). Claiming a place someone already made does not add
-- anyone, so it is always allowed. Unchanged otherwise from 0002.
create or replace function accept_invite(p_token_hash bytea, p_display_name text, p_claim uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  joiner uuid := app_user_id();
  target uuid;
  existing members%rowtype;
  rejoining boolean;
  people_limit constant integer := 50;
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
  if found and existing.left_at is null then
    return target;
  end if;
  rejoining := found;

  if (rejoining or p_claim is null)
     and (select count(*) from members where group_id = target and left_at is null) >= people_limit then
    raise exception 'This group already has % people', people_limit using errcode = 'program_limit_exceeded';
  end if;

  if rejoining then
    update members set left_at = null where id = existing.id;
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
