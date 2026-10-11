-- Apply after 20261011000000_room_foundation.sql. No live application without approval.
begin;

grant usage on schema public to authenticated;

-- Private administrator configuration. Quotas count retained rows, including finished rooms.
create table room_private.room_limits (
  singleton boolean primary key default true check (singleton),
  create_requests integer not null default 5 check (create_requests between 1 and 10000),
  create_window_seconds integer not null default 600 check (create_window_seconds between 1 and 86400),
  join_requests integer not null default 20 check (join_requests between 1 and 10000),
  join_window_seconds integer not null default 60 check (join_window_seconds between 1 and 86400),
  owned_rooms integer not null default 3 check (owned_rooms between 1 and 1000),
  memberships_per_user integer not null default 10 check (memberships_per_user between 1 and 1000),
  members_per_room integer not null default 20 check (members_per_room between 1 and 1000)
);
insert into room_private.room_limits(singleton) values (true);

create table room_private.room_request_budgets (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  create_window_started_at timestamptz not null default clock_timestamp(),
  create_count integer not null default 0 check (create_count >= 0),
  join_window_started_at timestamptz not null default clock_timestamp(),
  join_count integer not null default 0 check (join_count >= 0)
);
alter table room_private.room_limits enable row level security;
alter table room_private.room_request_budgets enable row level security;
revoke all on room_private.room_limits, room_private.room_request_budgets from public, anon, authenticated;

-- Called only inside the trusted RPCs. The actor row serializes both RPCs for that user.
-- A shared config lock makes administrator updates coherent for the whole transaction.
create function room_private.consume_room_request(p_actor uuid, p_action text)
returns boolean language plpgsql set search_path = '' set lock_timeout = '2s' as $$
declare
  limits room_private.room_limits%rowtype;
  budget room_private.room_request_budgets%rowtype;
  instant timestamptz := pg_catalog.clock_timestamp();
begin
  select * into strict limits from room_private.room_limits where singleton for share;
  insert into room_private.room_request_budgets(auth_user_id) values (p_actor)
  on conflict (auth_user_id) do nothing;
  select * into strict budget from room_private.room_request_budgets
  where auth_user_id = p_actor for update;
  instant := pg_catalog.clock_timestamp();
  if p_action = 'create' then
    if instant >= budget.create_window_started_at + pg_catalog.make_interval(secs => limits.create_window_seconds) then
      budget.create_window_started_at := instant;
      budget.create_count := 0;
    end if;
    if budget.create_count >= limits.create_requests then return false; end if;
    update room_private.room_request_budgets
    set create_window_started_at = budget.create_window_started_at, create_count = budget.create_count + 1
    where auth_user_id = p_actor;
  elsif p_action = 'join' then
    if instant >= budget.join_window_started_at + pg_catalog.make_interval(secs => limits.join_window_seconds) then
      budget.join_window_started_at := instant;
      budget.join_count := 0;
    end if;
    if budget.join_count >= limits.join_requests then return false; end if;
    update room_private.room_request_budgets
    set join_window_started_at = budget.join_window_started_at, join_count = budget.join_count + 1
    where auth_user_id = p_actor;
  else
    raise exception 'Invalid internal action';
  end if;
  return true;
end;
$$;
revoke all on function room_private.consume_room_request(uuid, text) from public, anon, authenticated;

-- Structured domain rejection commits the counter. Exceptions would roll it back.
-- Recreate rather than retain an unprotected overload with the previous return shape.
drop function public.create_robot_room(text);
drop function public.join_robot_room(text, text);

create function public.create_robot_room(p_nickname text)
returns table(room_id uuid, participant_id uuid, error_code text)
language plpgsql security definer set search_path = ''
set lock_timeout = '2s' set statement_timeout = '5s' as $$
declare
  actor uuid := auth.uid();
  limits room_private.room_limits%rowtype;
  new_room_id uuid;
  new_participant_id uuid;
  display_name text;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not room_private.consume_room_request(actor, 'create') then
    return query select null::uuid, null::uuid, 'rate_limited'::text; return;
  end if;
  display_name := btrim(p_nickname);
  if display_name is null or char_length(display_name) not between 1 and 40 or display_name ~ '[[:cntrl:]]' then
    return query select null::uuid, null::uuid, 'invalid_nickname'::text; return;
  end if;
  select * into strict limits from room_private.room_limits where singleton;
  if (select count(*) from public.rooms where created_by = actor) >= limits.owned_rooms then
    return query select null::uuid, null::uuid, 'room_quota_exceeded'::text; return;
  end if;
  if (select count(*) from public.room_participants where auth_user_id = actor) >= limits.memberships_per_user then
    return query select null::uuid, null::uuid, 'membership_quota_exceeded'::text; return;
  end if;
  for attempt in 1..8 loop
    insert into public.rooms(join_code, created_by) values (room_private.generate_join_code(), actor)
    on conflict (join_code) do nothing returning id into new_room_id;
    exit when new_room_id is not null;
  end loop;
  if new_room_id is null then
    return query select null::uuid, null::uuid, 'code_allocation_failed'::text; return;
  end if;
  insert into public.room_participants(room_id, auth_user_id, nickname, role)
  values (new_room_id, actor, display_name, 'organizer') returning id into new_participant_id;
  return query select new_room_id, new_participant_id, null::text;
end;
$$;
revoke all on function public.create_robot_room(text) from public, anon, authenticated;
grant execute on function public.create_robot_room(text) to authenticated;

create function public.join_robot_room(p_join_code text, p_nickname text)
returns table(room_id uuid, participant_id uuid, error_code text)
language plpgsql security definer set search_path = ''
set lock_timeout = '2s' set statement_timeout = '5s' as $$
declare
  actor uuid := auth.uid();
  limits room_private.room_limits%rowtype;
  normalized_code text;
  display_name text;
  target public.rooms%rowtype;
  existing_participant_id uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not room_private.consume_room_request(actor, 'join') then
    return query select null::uuid, null::uuid, 'rate_limited'::text; return;
  end if;
  display_name := btrim(p_nickname);
  if display_name is null or char_length(display_name) not between 1 and 40 or display_name ~ '[[:cntrl:]]' then
    return query select null::uuid, null::uuid, 'invalid_nickname'::text; return;
  end if;
  if p_join_code is null or char_length(p_join_code) > 32 then
    return query select null::uuid, null::uuid, 'room_unavailable'::text; return;
  end if;
  normalized_code := upper(replace(btrim(p_join_code), '-', ''));
  if normalized_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$' then
    return query select null::uuid, null::uuid, 'room_unavailable'::text; return;
  end if;
  select room.* into target from public.rooms as room where room.join_code = normalized_code for update;
  if not found then
    return query select null::uuid, null::uuid, 'room_unavailable'::text; return;
  end if;
  select participant.id into existing_participant_id from public.room_participants as participant
  where participant.room_id = target.id and participant.auth_user_id = actor;
  if found then
    return query select target.id, existing_participant_id, null::text; return;
  end if;
  if target.status <> 'waiting' then
    return query select null::uuid, null::uuid, 'room_unavailable'::text; return;
  end if;
  select * into strict limits from room_private.room_limits where singleton;
  if (select count(*) from public.room_participants where auth_user_id = actor) >= limits.memberships_per_user then
    return query select null::uuid, null::uuid, 'membership_quota_exceeded'::text; return;
  end if;
  if (select count(*) from public.room_participants where room_participants.room_id = target.id) >= limits.members_per_room then
    -- Same response as an unavailable invitation; no room metadata leaks on rejection.
    return query select null::uuid, null::uuid, 'room_unavailable'::text; return;
  end if;
  insert into public.room_participants(room_id, auth_user_id, nickname, role)
  values (target.id, actor, display_name, 'participant') returning id into existing_participant_id;
  return query select target.id, existing_participant_id, null::text;
end;
$$;
revoke all on function public.join_robot_room(text, text) from public, anon, authenticated;
grant execute on function public.join_robot_room(text, text) to authenticated;

-- PostgREST honors function timeouts. Also bound authenticated-role statements to 8s,
-- retaining any existing tighter role timeout. SET ROLE alone does not load role settings.
do $$
declare
  configured text;
  original_timeout text := current_setting('statement_timeout');
  timeout_ms bigint;
begin
  select substr(setting, length('statement_timeout=') + 1) into configured
  from pg_roles, unnest(rolconfig) as setting
  where rolname = 'authenticated' and setting like 'statement_timeout=%';
  if configured is not null then
    perform set_config('statement_timeout', configured, true);
    select setting::bigint into timeout_ms from pg_settings where name = 'statement_timeout';
    perform set_config('statement_timeout', original_timeout, true);
  end if;
  if timeout_ms is null or timeout_ms = 0 or timeout_ms > 8000 then
    alter role authenticated set statement_timeout = '8s';
    timeout_ms := 8000;
  end if;
  -- A function timeout takes precedence in PostgREST; do not override a tighter role limit.
  if timeout_ms < 5000 then
    execute format('alter function public.create_robot_room(text) set statement_timeout = %L', timeout_ms || 'ms');
    execute format('alter function public.join_robot_room(text, text) set statement_timeout = %L', timeout_ms || 'ms');
  end if;
end;
$$;
notify pgrst, 'reload config';

comment on table room_private.room_limits is 'Admin-only limits; fixed windows per JWT user, quotas include retained finished rooms.';
comment on function public.create_robot_room(text) is 'JWT-bound atomic creation; nullable error_code communicates counted domain rejection.';
comment on function public.join_robot_room(text, text) is 'JWT-bound admission with counted attempts; existing membership is preserved.';
commit;
