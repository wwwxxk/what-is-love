-- REVIEW BEFORE APPLYING TO A LIVE PROJECT. No existing data is overwritten.
begin;

create schema room_private;
revoke all on schema room_private from public, anon, authenticated;
grant usage on schema room_private to authenticated;

create type public.room_status as enum (
  'waiting', 'task_assignment', 'creating', 'gallery', 'awakening',
  'robot_ready', 'conversation', 'voting', 'finished'
);
create type public.participant_role as enum ('organizer', 'participant');

create table public.rooms (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  join_code text not null unique,
  status public.room_status not null default 'waiting',
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  constraint rooms_join_code_format check (join_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$'),
  constraint rooms_started_at_valid check (started_at is null or started_at >= created_at)
);

create table public.room_participants (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null,
  role public.participant_role not null default 'participant',
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint room_participants_unique_membership unique (room_id, auth_user_id),
  constraint room_participants_nickname_valid check (
    nickname = btrim(nickname) and char_length(nickname) between 1 and 40
    and nickname !~ '[[:cntrl:]]'
  )
);

create index rooms_created_by_idx on public.rooms(created_by);
create index room_participants_user_idx on public.room_participants(auth_user_id, room_id);
create index room_participants_joined_idx on public.room_participants(room_id, joined_at, id);
create unique index room_participants_one_organizer_idx
  on public.room_participants(room_id) where role = 'organizer';

create function room_private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function room_private.set_updated_at() from public, anon, authenticated;

create trigger rooms_updated_at before update on public.rooms
for each row execute function room_private.set_updated_at();
create trigger room_participants_updated_at before update on public.room_participants
for each row execute function room_private.set_updated_at();

alter table public.rooms enable row level security;
alter table public.room_participants enable row level security;

-- A narrow helper avoids querying room_participants recursively through its RLS.
-- Caller identity is taken exclusively from the authenticated JWT, never an argument.
create function room_private.is_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_participants as participant
    where participant.room_id = p_room_id and participant.auth_user_id = (select auth.uid())
  );
$$;
revoke all on function room_private.is_room_member(uuid) from public, anon, authenticated;
grant execute on function room_private.is_room_member(uuid) to authenticated;

create policy rooms_member_read on public.rooms for select to authenticated
using (room_private.is_room_member(id));
create policy room_participants_member_read on public.room_participants for select to authenticated
using (room_private.is_room_member(room_id));

-- Both table privileges AND RLS deny direct mutations, including self-promotion.
-- No organizer status/role editing API exists in this phase.
revoke all on public.rooms, public.room_participants from public, anon, authenticated;
grant select on public.rooms, public.room_participants to authenticated;

-- 12 characters, 60 random bits; excludes ambiguous I/O/0/1.
-- First byte of a new random UUID is unbiased; no pgcrypto extension is required.
create function room_private.generate_join_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
begin
  for position in 1..12 loop
    result := result || substr(alphabet,
      (pg_catalog.get_byte(pg_catalog.uuid_send(pg_catalog.gen_random_uuid()), 0) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;
revoke all on function room_private.generate_join_code() from public, anon, authenticated;

create function public.create_robot_room(p_nickname text)
returns table(room_id uuid, participant_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  new_room_id uuid;
  new_participant_id uuid;
  display_name text := btrim(p_nickname);
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if display_name is null or char_length(display_name) not between 1 and 40
    or display_name ~ '[[:cntrl:]]' then
    raise exception 'Invalid nickname' using errcode = '22023';
  end if;

  -- Retry only join-code collisions. Other constraint failures remain failures.
  for attempt in 1..8 loop
    insert into public.rooms(join_code, created_by)
    values (room_private.generate_join_code(), actor)
    on conflict (join_code) do nothing
    returning id into new_room_id;
    exit when new_room_id is not null;
  end loop;
  if new_room_id is null then
    raise exception 'Could not allocate a room code; retry' using errcode = '23505';
  end if;

  insert into public.room_participants(room_id, auth_user_id, nickname, role)
  values (new_room_id, actor, display_name, 'organizer')
  returning id into new_participant_id;
  return query select new_room_id, new_participant_id;
end;
$$;
revoke all on function public.create_robot_room(text) from public, anon, authenticated;
grant execute on function public.create_robot_room(text) to authenticated;

create function public.join_robot_room(p_join_code text, p_nickname text)
returns table(room_id uuid, participant_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  normalized_code text := upper(replace(btrim(p_join_code), '-', ''));
  display_name text := btrim(p_nickname);
  target public.rooms%rowtype;
  existing_participant_id uuid;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if display_name is null or char_length(display_name) not between 1 and 40
    or display_name ~ '[[:cntrl:]]' then
    raise exception 'Invalid nickname' using errcode = '22023';
  end if;
  if p_join_code is null or char_length(p_join_code) > 32
    or normalized_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$' then
    raise exception 'Room unavailable' using errcode = 'P0001';
  end if;

  -- Serializes joining against room lifecycle updates and simultaneous rejoining.
  select room.* into target from public.rooms as room
  where room.join_code = normalized_code for update;
  if not found then
    raise exception 'Room unavailable' using errcode = 'P0001';
  end if;

  select participant.id into existing_participant_id from public.room_participants as participant
  where participant.room_id = target.id and participant.auth_user_id = actor;
  -- Existing members can recover in any phase; their nickname and role stay intact.
  if found then
    return query select target.id, existing_participant_id;
    return;
  end if;
  if target.status <> 'waiting' then
    raise exception 'Room unavailable' using errcode = 'P0001';
  end if;

  insert into public.room_participants(room_id, auth_user_id, nickname, role)
  values (target.id, actor, display_name, 'participant')
  on conflict on constraint room_participants_unique_membership do nothing
  returning id into existing_participant_id;
  if existing_participant_id is null then
    select participant.id into existing_participant_id from public.room_participants as participant
    where participant.room_id = target.id and participant.auth_user_id = actor;
  end if;
  return query select target.id, existing_participant_id;
end;
$$;
revoke all on function public.join_robot_room(text, text) from public, anon, authenticated;
grant execute on function public.join_robot_room(text, text) to authenticated;

comment on function public.create_robot_room(text) is
  'Atomic room + organizer creation using the authenticated JWT identity. No service-role client required.';
comment on function public.join_robot_room(text, text) is
  'Invitation-based membership for authenticated users. Unknown and closed rooms share one error. Existing membership is preserved.';

-- Realtime publication is deliberately unchanged; enable it only for reviewed future subscriptions.
commit;
