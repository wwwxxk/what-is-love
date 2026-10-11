-- CHECKPOINT A DRAFT. Do not execute locally or remotely without separate approval.
-- Apply after both reviewed Phase 1A migrations. No enum values or admission RPCs change.
begin;

-- Bound DDL without increasing an operator's existing tighter transaction settings.
do $$
begin
  if (select setting::bigint from pg_catalog.pg_settings where name = 'lock_timeout') = 0
    or (select setting::bigint from pg_catalog.pg_settings where name = 'lock_timeout') > 2000 then
    perform pg_catalog.set_config('lock_timeout', '2s', true);
  end if;
  if (select setting::bigint from pg_catalog.pg_settings where name = 'statement_timeout') = 0
    or (select setting::bigint from pg_catalog.pg_settings where name = 'statement_timeout') > 30000 then
    perform pg_catalog.set_config('statement_timeout', '30s', true);
  end if;
  if current_user <> 'postgres' then
    raise exception 'Apply as the reviewed postgres migration owner';
  end if;
  if exists (
    select 1 from pg_catalog.pg_class as relation
    where relation.oid in ('public.rooms'::regclass, 'public.room_participants'::regclass)
      and (pg_catalog.pg_get_userbyid(relation.relowner) <> 'postgres'
        or not relation.relrowsecurity or relation.relforcerowsecurity)
  ) then
    raise exception 'Room ownership/RLS differs from the reviewed Phase 1A baseline';
  end if;
  if pg_catalog.has_table_privilege('authenticated', 'public.rooms', 'INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('authenticated', 'public.room_participants', 'INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('anon', 'public.rooms', 'INSERT,UPDATE,DELETE')
    or pg_catalog.has_table_privilege('anon', 'public.room_participants', 'INSERT,UPDATE,DELETE') then
    raise exception 'Unexpected direct room write privileges; review before deployment';
  end if;
  if not pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE')
    or not pg_catalog.has_schema_privilege('authenticated', 'room_private', 'USAGE')
    or not pg_catalog.has_table_privilege('authenticated', 'public.rooms', 'SELECT')
    or not pg_catalog.has_table_privilege('authenticated', 'public.room_participants', 'SELECT')
    or not pg_catalog.has_function_privilege('authenticated', 'room_private.is_room_member(uuid)', 'EXECUTE') then
    raise exception 'Reviewed member-read privileges are absent; investigate without broadening grants';
  end if;
end;
$$;

-- Canonical decimal TEXT also keeps existing SELECT * / PostgREST responses safe
-- for JavaScript, not just the new RPCs. Arithmetic uses bounded PostgreSQL bigint.
-- Existing records begin at '0' without changing their timestamps or state.
alter table public.rooms add column room_version text not null default '0';
alter table public.rooms add constraint rooms_version_nonnegative check (
  case when room_version ~ '^(0|[1-9][0-9]{0,18})$'
    then room_version::numeric between 0 and 9223372036854775807
    else false end
);

create function room_private.advance_room_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  -- updated_at-only writes are not experience changes. A membership trigger requests
  -- an increment by changing room_version; supplied values can never reset/jump it.
  if row(new.id, new.join_code, new.status, new.created_by, new.created_at,
      new.started_at, new.room_version) is distinct from
    row(old.id, old.join_code, old.status, old.created_by, old.created_at,
      old.started_at, old.room_version) then
    new.room_version := (old.room_version::bigint + 1)::text;
  else
    new.room_version := old.room_version;
  end if;
  return new;
end;
$$;
revoke all on function room_private.advance_room_version() from public, anon, authenticated;

create trigger rooms_advance_version before update on public.rooms
for each row execute function room_private.advance_room_version();

create function room_private.invalidate_room_membership()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  affected_rooms uuid[];
  affected_room uuid;
begin
  if tg_op = 'INSERT' then
    affected_rooms := array[new.room_id];
  elsif tg_op = 'DELETE' then
    affected_rooms := array[old.room_id];
  else
    if row(new.id, new.room_id, new.auth_user_id, new.nickname, new.role, new.joined_at)
      is not distinct from
      row(old.id, old.room_id, old.auth_user_id, old.nickname, old.role, old.joined_at) then
      return null;
    end if;
    affected_rooms := array[old.room_id, new.room_id];
  end if;

  -- Existing admission already locks its room before inserting membership. This
  -- trigger acquires no actor/configuration locks. Privileged multi-room maintenance
  -- must lock affected rooms first in UUID order before changing participant rows.
  for affected_room in
    select distinct candidate.room_id
    from pg_catalog.unnest(affected_rooms) as candidate(room_id)
    order by candidate.room_id
  loop
    update public.rooms as room set room_version = (room.room_version::bigint + 1)::text
    where room.id = affected_room;
    -- Cascading room deletion has no remaining parent to invalidate.
  end loop;
  return null;
end;
$$;
revoke all on function room_private.invalidate_room_membership() from public, anon, authenticated;

create trigger room_participants_invalidate_room
after insert or update or delete on public.room_participants
for each row execute function room_private.invalidate_room_membership();

-- One SQL statement, one MVCC snapshot, existing table RLS throughout. No elevated
-- reader and no identity arguments. Missing/unauthorized rooms have the same result.
create function public.get_robot_room_snapshot(p_room_id uuid)
returns table(room jsonb, participant_id uuid, members jsonb, room_version text, error_code text)
language sql stable security invoker set search_path = ''
set lock_timeout = '2s' set statement_timeout = '5s' as $$
  with authorized_snapshot as materialized (
    select
      pg_catalog.to_jsonb(room) || pg_catalog.jsonb_build_object('room_version', room.room_version::text) as room,
      caller.id as participant_id,
      (
        select coalesce(
          pg_catalog.jsonb_agg(pg_catalog.to_jsonb(member) order by member.joined_at, member.id),
          '[]'::jsonb
        )
        from public.room_participants as member where member.room_id = room.id
      ) as members,
      room.room_version::text as room_version
    from public.rooms as room
    join public.room_participants as caller on caller.room_id = room.id
      and caller.auth_user_id = (select auth.uid())
    where room.id = p_room_id
  )
  select snapshot.room, snapshot.participant_id, snapshot.members, snapshot.room_version, null::text
  from authorized_snapshot as snapshot
  union all
  select null::jsonb, null::uuid, null::jsonb, null::text, 'room_unavailable'::text
  where not exists (select 1 from authorized_snapshot);
$$;
revoke all on function public.get_robot_room_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.get_robot_room_snapshot(uuid) to authenticated;

create function public.start_robot_room(p_room_id uuid)
returns table(room_id uuid, status public.room_status, started_at timestamptz,
  room_version text, already_started boolean, error_code text)
language plpgsql security definer set search_path = ''
set lock_timeout = '2s' set statement_timeout = '5s' as $$
declare
  actor uuid := auth.uid();
  actor_role text;
  creator uuid;
  target public.rooms%rowtype;
begin
  if actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;

  -- Reject outsiders/non-organizers before allowing them to contend on a room lock.
  select participant.role::text, room.created_by into actor_role, creator
  from public.rooms as room join public.room_participants as participant
    on participant.room_id = room.id and participant.auth_user_id = actor
  where room.id = p_room_id;
  if not found then
    return query select null::uuid, null::public.room_status, null::timestamptz,
      null::text, null::boolean, 'room_unavailable'::text;
    return;
  end if;
  if actor_role <> 'organizer' or creator <> actor then
    return query select null::uuid, null::public.room_status, null::timestamptz,
      null::text, null::boolean, 'not_organizer'::text;
    return;
  end if;

  -- Same room lock as join_robot_room; no earlier actor/configuration locks are taken.
  select room.* into target from public.rooms as room where room.id = p_room_id for update;
  if not found then
    return query select null::uuid, null::public.room_status, null::timestamptz,
      null::text, null::boolean, 'room_unavailable'::text;
    return;
  end if;
  if target.created_by <> actor or not exists (
    select 1 from public.room_participants as participant
    where participant.room_id = target.id and participant.auth_user_id = actor
      and participant.role = 'organizer'
  ) then
    return query select null::uuid, null::public.room_status, null::timestamptz,
      null::text, null::boolean, 'room_unavailable'::text;
    return;
  end if;

  if target.status <> 'waiting' then
    if target.started_at is null then
      -- Do not invent timestamps for legacy/manual inconsistent state.
      return query select null::uuid, null::public.room_status, null::timestamptz,
        null::text, null::boolean, 'invalid_room_state'::text;
      return;
    end if;
    -- Includes future stages: never regress a room that has already started.
    return query select target.id, target.status, target.started_at,
      target.room_version::text, true, null::text;
    return;
  end if;
  if target.started_at is not null then
    return query select null::uuid, null::public.room_status, null::timestamptz,
      null::text, null::boolean, 'invalid_room_state'::text;
    return;
  end if;

  -- A valid organizer may start alone. No online count, Presence, or quorum.
  update public.rooms as room
  set status = 'task_assignment', started_at = pg_catalog.clock_timestamp()
  where room.id = target.id returning room.* into target;
  return query select target.id, target.status, target.started_at,
    target.room_version::text, false, null::text;
end;
$$;
revoke all on function public.start_robot_room(uuid) from public, anon, authenticated;
grant execute on function public.start_robot_room(uuid) to authenticated;

-- Keep stricter role/database/admission-RPC limits. Alter only the NEW functions,
-- never authenticated's existing 8s role setting. PostgREST must still set the
-- request timeout before execution; function SET alone cannot restart a SQL timer.
do $$
declare
  setting_name text;
  candidate record;
  original_value text;
  candidate_ms bigint;
  limit_ms bigint;
begin
  foreach setting_name in array array['statement_timeout', 'lock_timeout'] loop
    limit_ms := case when setting_name = 'statement_timeout' then 5000 else 2000 end;
    original_value := pg_catalog.current_setting(setting_name);
    for candidate in
      select pg_catalog.substr(config.value, pg_catalog.length(setting_name) + 2) as value
      from pg_catalog.pg_db_role_setting as defaults
      cross join lateral pg_catalog.unnest(defaults.setconfig) as config(value)
      where defaults.setrole in (0, (select oid from pg_catalog.pg_roles where rolname = 'authenticated'))
        and defaults.setdatabase in (0, (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database()))
        and config.value like setting_name || '=%'
      union all
      select pg_catalog.substr(config.value, pg_catalog.length(setting_name) + 2)
      from pg_catalog.pg_proc as routine
      cross join lateral pg_catalog.unnest(routine.proconfig) as config(value)
      where routine.oid in ('public.create_robot_room(text)'::regprocedure, 'public.join_robot_room(text,text)'::regprocedure)
        and config.value like setting_name || '=%'
    loop
      perform pg_catalog.set_config(setting_name, candidate.value, true);
      select setting::bigint into candidate_ms from pg_catalog.pg_settings where name = setting_name;
      if candidate_ms > 0 and candidate_ms < limit_ms then limit_ms := candidate_ms; end if;
    end loop;
    perform pg_catalog.set_config(setting_name, original_value, true);
    execute pg_catalog.format('alter function public.get_robot_room_snapshot(uuid) set %I = %L', setting_name, limit_ms || 'ms');
    execute pg_catalog.format('alter function public.start_robot_room(uuid) set %I = %L', setting_name, limit_ms || 'ms');
  end loop;
end;
$$;

comment on column public.rooms.room_version is 'Canonical nonnegative decimal revision, bigint arithmetic; legacy SELECTs, RPCs and Broadcast all expose strings.';
comment on function public.get_robot_room_snapshot(uuid) is 'Single-statement member snapshot under existing RLS; unavailable results reveal no room metadata.';
comment on function public.start_robot_room(uuid) is 'JWT-bound organizer-only waiting -> task_assignment; concurrent joins serialize; repeats do not update.';

notify pgrst, 'reload schema';
commit;
