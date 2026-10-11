-- LOCAL TEST MODEL ONLY; not a Supabase deployment or Realtime service.
-- fixture_admin is the bootstrap superuser. This avoids PostgreSQL's prohibition
-- on removing SUPERUSER from its bootstrap role while modeling hosted postgres.
create role postgres login superuser;
set role postgres;
create role anon nologin;
create role authenticated nologin;
create role supabase_realtime_admin nologin;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
revoke usage on schema public from public, authenticated;
create function auth.test_auto_rls() returns event_trigger language plpgsql as $$
declare command record;
begin
  for command in select * from pg_event_trigger_ddl_commands()
    where command_tag='CREATE TABLE' and object_type='table' loop
    if command.schema_name='public' then
      execute format('alter table %s enable row level security', command.object_identity);
    end if;
  end loop;
end;
$$;
create event trigger test_auto_rls on ddl_command_end when tag in ('CREATE TABLE')
execute function auth.test_auto_rls();

create schema realtime authorization supabase_realtime_admin;
create schema fixture;
create table fixture.send_control(fail_on_topic text);
insert into fixture.send_control values (null);
grant usage on schema fixture to postgres;
grant select, update on fixture.send_control to postgres;
set role supabase_realtime_admin;
create table realtime.messages (
  id uuid primary key default gen_random_uuid(),
  topic text not null, extension text not null, payload jsonb,
  event text, private boolean not null default true
);
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable security invoker as $$
  select nullif(current_setting('realtime.topic', true), '');
$$;
-- Explicit test double: enqueue a SQL row or raise an injected failure.
-- Does NOT simulate WebSockets, partitioning, or provider exception handling.
create function realtime.send(payload jsonb, event text, topic text, private boolean)
returns void language plpgsql security invoker as $$
begin
  if exists (select 1 from fixture.send_control where fail_on_topic = topic) then
    raise exception 'Injected local publisher failure' using errcode='P0001';
  end if;
  insert into realtime.messages(topic, extension, payload, event, private)
    values (topic, 'broadcast', payload, event, private);
end;
$$;
revoke all on function realtime.send(jsonb,text,text,boolean) from public;
grant execute on function realtime.send(jsonb,text,text,boolean) to postgres;
grant execute on function realtime.topic() to authenticated, anon;
grant usage on schema realtime to authenticated, anon;
grant select on realtime.messages to authenticated, anon;
reset role;
grant supabase_realtime_admin to postgres;
grant authenticated, anon to postgres with admin true, inherit false, set true;
-- Normal migration owner is NOT superuser; inherits platform table ownership.
alter role postgres nosuperuser bypassrls createrole createdb;
