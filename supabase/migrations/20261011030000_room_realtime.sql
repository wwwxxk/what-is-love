-- CHECKPOINT A DRAFT. Do not execute locally or remotely without separate approval.
-- Apply after 20261011020000_room_lifecycle.sql, after reviewing HOSTED Realtime
-- function definitions, grants and every existing realtime.messages policy.
begin;

do $$
declare
  publisher oid;
begin
  if (select setting::bigint from pg_catalog.pg_settings where name = 'lock_timeout') = 0
    or (select setting::bigint from pg_catalog.pg_settings where name = 'lock_timeout') > 2000 then
    perform pg_catalog.set_config('lock_timeout', '2s', true);
  end if;
  if (select setting::bigint from pg_catalog.pg_settings where name = 'statement_timeout') = 0
    or (select setting::bigint from pg_catalog.pg_settings where name = 'statement_timeout') > 30000 then
    perform pg_catalog.set_config('statement_timeout', '30s', true);
  end if;
  if current_user <> 'postgres' then raise exception 'Apply as the reviewed postgres migration owner'; end if;
  if pg_catalog.to_regprocedure('public.get_robot_room_snapshot(uuid)') is null
    or pg_catalog.to_regprocedure('public.start_robot_room(uuid)') is null then
    raise exception 'Apply the reviewed room lifecycle migration first';
  end if;
  if pg_catalog.to_regclass('realtime.messages') is null
    or pg_catalog.to_regprocedure('realtime.topic()') is null
    or pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    raise exception 'Hosted Supabase database Broadcast prerequisites are missing';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'realtime.messages'::regclass) then
    raise exception 'Realtime message RLS must already be enabled; do not change platform settings here';
  end if;
  if not pg_catalog.has_schema_privilege('authenticated', 'realtime', 'USAGE')
    or not pg_catalog.has_table_privilege('authenticated', 'realtime.messages', 'SELECT')
    or not pg_catalog.has_function_privilege('authenticated', 'realtime.topic()', 'EXECUTE')
    or not pg_catalog.has_function_privilege(current_user, 'realtime.send(jsonb,text,text,boolean)', 'EXECUTE') then
    -- Adding global table/schema privileges could enable unrelated existing policies.
    raise exception 'Required platform privileges are absent; review separately instead of broadening grants';
  end if;
  select case when routine.prosecdef then routine.proowner
    else (select oid from pg_catalog.pg_roles where rolname = current_user) end into publisher
  from pg_catalog.pg_proc as routine
  where routine.oid = 'realtime.send(jsonb,text,text,boolean)'::regprocedure;
  if not pg_catalog.has_table_privilege(publisher, 'realtime.messages'::regclass, 'INSERT')
    or not exists (
      select 1 from pg_catalog.pg_roles as role, pg_catalog.pg_class as relation
      where role.oid = publisher and relation.oid = 'realtime.messages'::regclass
        and (role.rolsuper or role.rolbypassrls
          or (relation.relowner = role.oid and not relation.relforcerowsecurity))
    ) then
    raise exception 'Trusted database publisher cannot bypass client-only message restrictions';
  end if;
  -- New scoped guards safely constrain existing permissive policies. An existing
  -- restrictive SELECT/ALL policy may exclude this new namespace even when our
  -- permissive reader allows it; reject until its compatibility is reviewed.
  if exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'realtime.messages'::regclass and not polpermissive and polcmd in ('r', '*')
  ) then
    raise exception 'Existing restrictive Realtime read policies require a reviewed coexistence design';
  end if;
end;
$$;

-- The PUBLIC read guard must not read application tables as the caller: even an
-- unrelated-topic OR branch cannot suppress PostgreSQL's relation ACL checks.
-- Only this JWT-bound boolean lookup runs as the reviewed room table owner.
-- No actor argument, UUID casts of hostile topics, membership rows, or mutations.
create function room_private.owns_room_broadcast_topic(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.room_participants as participant
    where participant.auth_user_id = (select auth.uid())
      and p_topic = pg_catalog.format('wil:room:%s:member:%s', participant.room_id, participant.id)
  );
$$;
revoke all on function room_private.owns_room_broadcast_topic(text) from public, anon, authenticated;
-- Intentional PUBLIC EXECUTE: the restrictive guard applies to PUBLIC, including
-- anon and other readers of unrelated topics. Narrow role grants would reproduce
-- a function-permission failure for uncovered roles. The result concerns only the
-- caller's own JWT identity; absent identity returns false. No schema/table grants
-- are added, and room_private remains outside the Data API's exposed schemas.
grant execute on function room_private.owns_room_broadcast_topic(text) to public;
comment on function room_private.owns_room_broadcast_topic(text) is
  'Policy-only JWT-bound own-membership boolean; postgres owner, empty search_path; PUBLIC execution prevents unrelated-topic ACL errors.';

-- SQL/API access to this reserved namespace AND channel authorization require the
-- same exact topic. Comparing formatted trusted UUIDs avoids casts of hostile text.
create policy wil_room_broadcast_member_read on realtime.messages
as permissive for select to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and realtime.messages.topic = (select realtime.topic())
  and room_private.owns_room_broadcast_topic(realtime.messages.topic)
);

-- Restrictive guards apply to ALL ordinary roles, including anon. A broad existing
-- or future permissive policy cannot open application topics to outsiders. Outside
-- this reserved namespace the existing policies continue to determine permissions.
create policy wil_room_broadcast_read_guard on realtime.messages
as restrictive for select to public
using (
  (
    coalesce(realtime.messages.topic, '') not like 'wil:room:%'
    and coalesce((select realtime.topic()), '') not like 'wil:room:%'
  )
  or (
    realtime.messages.extension = 'broadcast'
    and realtime.messages.topic = (select realtime.topic())
    and room_private.owns_room_broadcast_topic(realtime.messages.topic)
  )
);

create policy wil_room_broadcast_insert_guard on realtime.messages
as restrictive for insert to public
with check (
  coalesce(realtime.messages.topic, '') not like 'wil:room:%'
  and coalesce((select realtime.topic()), '') not like 'wil:room:%'
);

create policy wil_room_broadcast_update_guard on realtime.messages
as restrictive for update to public
using (coalesce(realtime.messages.topic, '') not like 'wil:room:%')
with check (coalesce(realtime.messages.topic, '') not like 'wil:room:%');

create policy wil_room_broadcast_delete_guard on realtime.messages
as restrictive for delete to public
using (coalesce(realtime.messages.topic, '') not like 'wil:room:%');

create function room_private.broadcast_room_change()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  membership record;
begin
  -- Run in the trusted mutating RPC/maintenance context, not an elevated public
  -- publisher RPC. Review the platform realtime.send contract before deployment:
  -- this helper does not catch errors, but the platform function may do so internally.
  -- Missed delivery is repaired by snapshots and 15-second visible-page polling.
  for membership in
    select participant.id from public.room_participants as participant
    where participant.room_id = new.id order by participant.id
  loop
    perform realtime.send(
      pg_catalog.jsonb_build_object('room_version', new.room_version::text),
      'room_changed',
      pg_catalog.format('wil:room:%s:member:%s', new.id, membership.id),
      true
    );
  end loop;
  -- Send only to current memberships, not a shared room channel with cached
  -- authorization. Revoked members receive no newly targeted notifications;
  -- already queued signals contain only a decimal-string version.
  return null;
end;
$$;
revoke all on function room_private.broadcast_room_change() from public, anon, authenticated;

create trigger rooms_broadcast_change after update on public.rooms
for each row when (old.room_version is distinct from new.room_version)
execute function room_private.broadcast_room_change();

comment on function room_private.broadcast_room_change() is
  'Trusted database invalidation fan-out to current private membership topics; version only, no client publisher.';

-- No new platform grants, schema exposure, publication, Presence, retention jobs,
-- client write permissions, or changes to unrelated Realtime policies.
commit;
