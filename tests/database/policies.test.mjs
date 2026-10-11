import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";

// Real PostgreSQL, on an isolated network with no ports or persistent mounts.
// Never reads a database URL, Supabase environment variable, or live credentials.
const image = "postgres@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826";
const container = `what-is-love-test-${randomUUID()}`;
const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const carol = "00000000-0000-4000-8000-000000000003";
let originalGenerator;
let originalLimits;

function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("docker", args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\n${stderr}`;
        reject(error);
      } else resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

async function sql(statement, user, role = "authenticated") {
  const prefix = user === undefined ? "" :
    `set role ${role}; set request.jwt.claim.sub = '${user}';`;
  return docker(["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres",
    "-d", "what_is_love_test", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"], `${prefix}\n${statement}`);
}

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
async function create(user = alice, nickname = "Alice") {
  const result = JSON.parse(await sql(`select row_to_json(result) from public.create_robot_room(${literal(nickname)}) as result;`, user));
  assert.equal(result.error_code, null);
  return result;
}
async function roomCode(roomId) {
  return sql(`select join_code from public.rooms where id = '${roomId}';`);
}
async function join(code, user = bob, nickname = "Bob") {
  const result = JSON.parse(await sql(`select row_to_json(result) from public.join_robot_room(${literal(code)}, ${literal(nickname)}) as result;`, user));
  assert.equal(result.error_code, null);
  return result;
}
async function denies(statement, user, code = "42501", role) {
  await assert.rejects(sql(statement, user, role), new RegExp(code));
}

async function rejectsDomain(expression, user, code) {
  const result = JSON.parse(await sql(`select row_to_json(result) from ${expression} as result;`, user));
  assert.deepEqual(result, { room_id: null, participant_id: null, error_code: code });
}

before(async () => {
  await docker(["run", "--detach", "--rm", "--name", container, "--network", "none",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=256m", "--label", "what-is-love.phase1a-test=true",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=what_is_love_test", image]);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await docker(["exec", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "what_is_love_test", "-c", "select 1;"]);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.ok(ready, "Isolated PostgreSQL must become ready");
  // Models the Supabase role/UID contract, not the Auth API or JWT verification.
  await sql(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    -- Model automatic RLS and opt-in object exposure before applying both migrations.
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
  `);
  await sql(await readFile(new URL("../../supabase/migrations/20261011000000_room_foundation.sql", import.meta.url), "utf8"));
  await sql(await readFile(new URL("../../supabase/migrations/20261011010000_room_security_hardening.sql", import.meta.url), "utf8"));
  originalLimits = JSON.parse(await sql("select row_to_json(limits) from room_private.room_limits as limits;"));
  originalGenerator = await sql("select pg_get_functiondef('room_private.generate_join_code()'::regprocedure);");
});

beforeEach(async () => {
  await sql(`truncate public.rooms, auth.users cascade;
    insert into auth.users(id) values ('${alice}'), ('${bob}'), ('${carol}');`);
  await sql(originalGenerator);
  await sql(`update room_private.room_limits set ${Object.entries(originalLimits)
    .filter(([key]) => key !== "singleton").map(([key, value]) => `${key}=${value}`).join(",")};`);
});

after(async () => {
  await docker(["rm", "--force", container]);
});

test("migration enables RLS and grants only member reads and reviewed RPC execution", async () => {
  const result = JSON.parse(await sql(`select json_build_object(
    'rooms_rls', (select relrowsecurity from pg_class where oid = 'public.rooms'::regclass),
    'participants_rls', (select relrowsecurity from pg_class where oid = 'public.room_participants'::regclass),
    'auth_read', has_table_privilege('authenticated', 'public.rooms', 'select'),
    'auth_write', has_table_privilege('authenticated', 'public.rooms', 'insert,update,delete'),
    'member_write', has_table_privilege('authenticated', 'public.room_participants', 'insert,update,delete'),
    'anon_read', has_table_privilege('anon', 'public.rooms', 'select'),
    'anon_create', has_function_privilege('anon', 'public.create_robot_room(text)', 'execute'),
    'anon_join', has_function_privilege('anon', 'public.join_robot_room(text,text)', 'execute'),
    'auth_create', has_function_privilege('authenticated', 'public.create_robot_room(text)', 'execute'),
    'auth_join', has_function_privilege('authenticated', 'public.join_robot_room(text,text)', 'execute'),
    'auth_generate', has_function_privilege('authenticated', 'room_private.generate_join_code()', 'execute'));
  `));
  assert.deepEqual(result, {
    rooms_rls: true, participants_rls: true, auth_read: true, auth_write: false,
    member_write: false, anon_read: false, anon_create: false, anon_join: false,
    auth_create: true, auth_join: true, auth_generate: false,
  });
  assert.equal(await sql(`select count(*) from pg_proc as function
    join pg_namespace as schema on schema.oid = function.pronamespace
    where (schema.nspname = 'room_private' or function.proname in ('create_robot_room','join_robot_room'))
    and function.prosecdef and (not function.proconfig @> array['search_path=""']
      or pg_get_userbyid(function.proowner) in ('anon','authenticated'));`), "0");
});

test("unauthenticated callers cannot create or join even with an invitation", async () => {
  await denies("select * from public.create_robot_room('Visitor');", "", "28000");
  await denies("select * from public.join_robot_room('AAAAAAAAAAAA','Visitor');", "", "28000");
  await denies("select * from public.create_robot_room('Visitor');", "", "42501", "anon");
  await denies("select * from public.join_robot_room('AAAAAAAAAAAA','Visitor');", "", "42501", "anon");
});

test("creation atomically binds a waiting room and organizer to the JWT user", async () => {
  const result = await create();
  const rows = JSON.parse(await sql(`select json_build_object(
    'creator', room.created_by, 'status', room.status, 'started_at', room.started_at,
    'user', participant.auth_user_id, 'role', participant.role, 'nickname', participant.nickname)
    from public.rooms as room join public.room_participants as participant on participant.room_id = room.id
    where room.id = '${result.room_id}';`, alice));
  assert.deepEqual(rows, { creator: alice, status: "waiting", started_at: null, user: alice, role: "organizer", nickname: "Alice" });
  assert.match(await roomCode(result.room_id), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
});

test("outsiders cannot discover a room or its participants by ID or valid code", async () => {
  const result = await create();
  const code = await roomCode(result.room_id);
  assert.equal(await sql(`select count(*) from public.rooms where id = '${result.room_id}' or join_code = '${code}';`, bob), "0");
  assert.equal(await sql(`select count(*) from public.room_participants where room_id = '${result.room_id}';`, bob), "0");
  assert.equal(await sql(`select room_private.is_room_member('${result.room_id}');`, bob), "f");
});

test("members read all members of their own room without recursive RLS", async () => {
  const result = await create();
  await join(await roomCode(result.room_id));
  assert.equal(await sql("select count(*) from public.rooms;", bob), "1");
  assert.equal(await sql("select count(*) from public.room_participants;", bob), "2");
  assert.equal(await sql("select count(*) from public.room_participants;", carol), "0");
});

test("a user can join multiple independent rooms without exposing other rooms", async () => {
  const first = await create();
  const second = await create(carol, "Carol");
  await create(alice, "Another room");
  await join(await roomCode(first.room_id));
  await join(await roomCode(second.room_id));
  assert.equal(await sql("select count(*) from public.rooms;", bob), "2");
  assert.equal(await sql("select count(*) from public.room_participants;", bob), "4");
});

test("sequential and concurrent rejoining preserve one membership and its display name", async () => {
  const result = await create();
  const code = await roomCode(result.room_id);
  const first = await join(code);
  const repeated = await join(code, bob, "A different display name");
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => join(code)));
  assert.deepEqual(first, repeated);
  for (const membership of concurrent) assert.deepEqual(membership, first);
  assert.equal(await sql(`select count(*) from public.room_participants where room_id = '${result.room_id}' and auth_user_id = '${bob}';`), "1");
  assert.equal(await sql(`select nickname from public.room_participants where id = '${first.participant_id}';`), "Bob");
});

test("concurrent first joins serialize and cannot produce duplicate memberships", async () => {
  const result = await create();
  const code = await roomCode(result.room_id);
  const memberships = await Promise.all(Array.from({ length: 6 }, () => join(code)));
  for (const membership of memberships) assert.deepEqual(membership, memberships[0]);
  assert.equal(await sql("select count(*) from public.room_participants;"), "2");
});

test("organizer rejoining cannot demote or replace the original organizer", async () => {
  const result = await create();
  assert.deepEqual(await join(await roomCode(result.room_id), alice, "New name"), result);
  assert.equal(await sql(`select role from public.room_participants where id = '${result.participant_id}';`), "organizer");
});

test("new members are rejected after waiting; existing members can restore in every phase", async () => {
  const result = await create();
  const code = await roomCode(result.room_id);
  const bobMembership = await join(code);
  for (const status of ["task_assignment","creating","gallery","awakening","robot_ready","conversation","voting","finished"]) {
    await sql(`update public.rooms set status = '${status}', started_at = now() where id = '${result.room_id}';`);
    await rejectsDomain(`public.join_robot_room('${code}','Carol')`, carol, "room_unavailable");
    assert.deepEqual(await join(code, bob), bobMembership);
  }
});

test("unknown, malformed, and closed-room invitations share the unavailable error", async () => {
  const result = await create();
  const code = await roomCode(result.room_id);
  await sql(`update public.rooms set status = 'finished' where id = '${result.room_id}';`);
  for (const invitation of ["INVALID", "111111111111", "ZZZZZZZZZZZZ", code]) {
    await rejectsDomain(`public.join_robot_room('${invitation}','Bob')`, bob, "room_unavailable");
  }
});

test("room codes accept lowercase and optional grouping without changing lookup", async () => {
  const result = await create();
  const code = await roomCode(result.room_id);
  const grouped = `${code.slice(0,4)}-${code.slice(4,8)}-${code.slice(8)}`.toLowerCase();
  assert.equal((await join(` ${grouped} `)).room_id, result.room_id);
});

test("all authenticated callers are denied direct room and membership mutations", async () => {
  const result = await create();
  await join(await roomCode(result.room_id));
  for (const user of [alice, bob, carol]) {
    for (const statement of [
      `insert into public.rooms(join_code,created_by) values ('AAAAAAAAAAAA','${user}');`,
      `update public.rooms set status='finished' where id='${result.room_id}';`,
      `delete from public.rooms where id='${result.room_id}';`,
      `insert into public.room_participants(room_id,auth_user_id,nickname,role) values ('${result.room_id}','${user}','Attack','organizer');`,
      `update public.room_participants set role='organizer' where auth_user_id='${user}';`,
      `update public.room_participants set nickname='Attack' where auth_user_id='${alice}';`,
      `delete from public.room_participants where room_id='${result.room_id}';`,
    ]) await denies(statement, user);
  }
});

test("invalid nicknames cannot leave an orphaned room", async () => {
  for (const nickname of ["", "   ", "x".repeat(41), "A\nB"]) {
    await rejectsDomain(`public.create_robot_room(${literal(nickname)})`, alice, "invalid_nickname");
  }
  assert.equal(await sql("select count(*) from public.rooms;"), "0");
  const unicode = "💛".repeat(40);
  await create(alice, unicode);
  assert.equal(await sql("select char_length(nickname) from public.room_participants;"), "40");
});

test("database constraints enforce statuses, duplicate membership, and foreign keys", async () => {
  const result = await create();
  await assert.rejects(sql(`update public.rooms set status='invented' where id='${result.room_id}';`), /22P02/);
  await assert.rejects(sql(`insert into public.room_participants(room_id,auth_user_id,nickname) values ('${result.room_id}','${alice}','Duplicate');`), /23505/);
  await assert.rejects(sql(`insert into public.room_participants(room_id,auth_user_id,nickname) values ('ffffffff-ffff-4fff-8fff-ffffffffffff','${bob}','Missing room');`), /23503/);
  await assert.rejects(sql(`insert into public.rooms(join_code,created_by) values ('AAAAAAAAAAAA','ffffffff-ffff-4fff-8fff-ffffffffffff');`), /23503/);
  await assert.rejects(sql(`insert into public.room_participants(room_id,auth_user_id,nickname,role) values ('${result.room_id}','${bob}','Second organizer','organizer');`), /23505/);
  await assert.rejects(sql(`update public.rooms set join_code='111111111111' where id='${result.room_id}';`), /23514/);
});

test("join-code collisions retry without failing a valid room creation", async () => {
  const first = await create();
  await sql(`update public.rooms set join_code='AAAAAAAAAAAA' where id='${first.room_id}';
    create sequence room_private.test_collision_counter;
    create or replace function room_private.generate_join_code() returns text language sql volatile set search_path='' as $$
      select case when nextval('room_private.test_collision_counter')=1 then 'AAAAAAAAAAAA' else 'BBBBBBBBBBBB' end;
    $$;`);
  try {
    const second = await create(bob, "Bob");
    assert.equal(await roomCode(second.room_id), "BBBBBBBBBBBB");
    assert.equal(await sql("select count(*) from public.rooms;"), "2");
    assert.equal(await sql("select count(*) from public.room_participants;"), "2");
  } finally {
    await sql(originalGenerator);
    await sql("drop sequence room_private.test_collision_counter;");
  }
});

test("collision retry exhaustion fails atomically instead of returning fake success", async () => {
  const first = await create();
  await sql(`update public.rooms set join_code='AAAAAAAAAAAA' where id='${first.room_id}';
    create or replace function room_private.generate_join_code() returns text language sql volatile set search_path='' as $$ select 'AAAAAAAAAAAA'::text; $$;`);
  try {
    await rejectsDomain("public.create_robot_room('Bob')", bob, "code_allocation_failed");
    assert.equal(await sql("select count(*) from public.rooms;"), "1");
    assert.equal(await sql("select count(*) from public.room_participants;"), "1");
  } finally { await sql(originalGenerator); }
});

test("random codes follow the format and trusted lifecycle updates refresh timestamps", async () => {
  assert.equal(await sql(`select count(distinct code) from (
    select room_private.generate_join_code() as code from generate_series(1,1000)) as codes
    where code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$';`), "1000");
  const result = await create();
  const initial = await sql(`select updated_at from public.rooms where id='${result.room_id}';`);
  await sql(`update public.rooms set status='task_assignment', started_at=now() where id='${result.room_id}';`);
  const updated = await sql(`select updated_at from public.rooms where id='${result.room_id}';`);
  assert.notEqual(initial, updated);
});

test("room deletion cascades membership, but organizer identity cannot be silently removed", async () => {
  const result = await create();
  await assert.rejects(sql(`delete from auth.users where id='${alice}';`), /23503/);
  await sql(`delete from public.rooms where id='${result.room_id}';`);
  assert.equal(await sql("select count(*) from public.room_participants;"), "0");
});

test("creation rate limit counts rejected input, stays actor-scoped, and resets after its window", async () => {
  await sql("update room_private.room_limits set create_requests=2, create_window_seconds=60;");
  await rejectsDomain("public.create_robot_room('')", alice, "invalid_nickname");
  await create();
  await rejectsDomain("public.create_robot_room('Alice')", alice, "rate_limited");
  await create(bob);
  assert.equal(await sql(`select create_count from room_private.room_request_budgets where auth_user_id='${alice}';`), "2");
  await sql(`update room_private.room_request_budgets set create_window_started_at=clock_timestamp()-interval '61 seconds' where auth_user_id='${alice}';`);
  await create();
  assert.equal(await sql(`select create_count from room_private.room_request_budgets where auth_user_id='${alice}';`), "1");
});

test("invalid and unknown invitations persist attempts, and concurrent attempts cannot exceed the limit", async () => {
  await sql("update room_private.room_limits set join_requests=2;");
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    sql("select row_to_json(result) from public.join_robot_room('BAD','Bob') as result;", bob).then(JSON.parse)));
  assert.equal(results.filter((result) => result.error_code === "room_unavailable").length, 2);
  assert.equal(results.filter((result) => result.error_code === "rate_limited").length, 6);
  assert.equal(await sql(`select join_count from room_private.room_request_budgets where auth_user_id='${bob}';`), "2");
  await sql(`update room_private.room_request_budgets set join_window_started_at=clock_timestamp()-interval '61 seconds' where auth_user_id='${bob}';`);
  await rejectsDomain("public.join_robot_room('ZZZZZZZZZZZZ','Bob')", bob, "room_unavailable");
  assert.equal(await sql(`select join_count from room_private.room_request_budgets where auth_user_id='${bob}';`), "1");
});

test("room quota remains atomic under concurrent creations and counts finished rooms", async () => {
  await sql("update room_private.room_limits set owned_rooms=2, create_requests=10;");
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    sql("select row_to_json(result) from public.create_robot_room('Alice') as result;", alice).then(JSON.parse)));
  assert.equal(results.filter((result) => result.error_code === null).length, 2);
  assert.equal(results.filter((result) => result.error_code === "room_quota_exceeded").length, 4);
  assert.equal(await sql("select count(*) from public.rooms;"), "2");
  assert.equal(await sql("select count(*) from public.room_participants;"), "2");
  await sql("update public.rooms set status='finished';");
  await rejectsDomain("public.create_robot_room('Alice')", alice, "room_quota_exceeded");
});

test("membership quota applies to create and join, including organizer membership; recovery still works", async () => {
  await sql("update room_private.room_limits set memberships_per_user=1;");
  const aliceRoom = await create();
  const carolRoom = await create(carol);
  await rejectsDomain(`public.join_robot_room('${await roomCode(carolRoom.room_id)}','Alice')`, alice, "membership_quota_exceeded");
  await rejectsDomain("public.create_robot_room('Alice')", alice, "membership_quota_exceeded");
  assert.deepEqual(await join(await roomCode(aliceRoom.room_id), alice), aliceRoom);
  assert.equal(await sql("select count(*) from public.rooms;"), "2");
});

test("per-room membership quota serializes distinct actors and permits existing-member recovery", async () => {
  await sql("update room_private.room_limits set members_per_room=2;");
  const room = await create();
  const code = await roomCode(room.room_id);
  const results = await Promise.all([bob, carol].map((actor) =>
    sql(`select row_to_json(result) from public.join_robot_room('${code}','Guest') as result;`, actor).then(JSON.parse)));
  assert.equal(results.filter((result) => result.error_code === null).length, 1);
  assert.equal(results.filter((result) => result.error_code === "room_unavailable").length, 1);
  assert.equal(await sql("select count(*) from public.room_participants;"), "2");
  assert.deepEqual(await join(code, alice), room);
});

test("create and join share the actor lock so concurrent operations cannot exceed total memberships", async () => {
  await sql("update room_private.room_limits set memberships_per_user=1;");
  const room = await create(carol);
  const code = await roomCode(room.room_id);
  const results = await Promise.all([
    sql("select row_to_json(result) from public.create_robot_room('Bob') as result;", bob).then(JSON.parse),
    sql(`select row_to_json(result) from public.join_robot_room('${code}','Bob') as result;`, bob).then(JSON.parse),
  ]);
  assert.equal(results.filter((result) => result.error_code === null).length, 1);
  assert.equal(results.filter((result) => result.error_code === "membership_quota_exceeded").length, 1);
  assert.equal(await sql(`select count(*) from public.room_participants where auth_user_id='${bob}';`), "1");
});

test("private limits and counters cannot be read, edited, or invoked by API users", async () => {
  for (const role of ["authenticated", "anon"]) {
    for (const statement of [
      "select * from room_private.room_limits;",
      "update room_private.room_limits set owned_rooms=1000;",
      "delete from room_private.room_request_budgets;",
      `select room_private.consume_room_request('${alice}','create');`,
    ]) await denies(statement, alice, "42501", role);
  }
  assert.equal(await sql("select has_schema_privilege('authenticated','public','usage');"), "t");
  await assert.rejects(sql("update room_private.room_limits set join_requests=0;"), /23514/);
});

test("timeout configuration bounds API statements and preserves tighter existing role limits", async () => {
  assert.equal(await sql("select rolconfig @> array['statement_timeout=8s'] from pg_roles where rolname='authenticated';"), "t");
  assert.equal(await sql(`select count(*) from pg_proc where oid in
    ('public.create_robot_room(text)'::regprocedure,'public.join_robot_room(text,text)'::regprocedure)
    and proconfig @> array['lock_timeout=2s','statement_timeout=5s'];`), "2");
  const migration = await readFile(new URL("../../supabase/migrations/20261011010000_room_security_hardening.sql", import.meta.url), "utf8");
  const timeoutBlock = migration.slice(migration.indexOf("do $$"), migration.indexOf("notify pgrst"));
  await sql("alter role authenticated set statement_timeout='1s';");
  try {
    await sql(timeoutBlock);
    assert.equal(await sql("select rolconfig @> array['statement_timeout=1s'] from pg_roles where rolname='authenticated';"), "t");
    assert.equal(await sql(`select count(*) from pg_proc where oid in
      ('public.create_robot_room(text)'::regprocedure,'public.join_robot_room(text,text)'::regprocedure)
      and proconfig @> array['statement_timeout=1000ms'];`), "2");
    // Model PostgREST setting the transaction timeout before executing an RPC.
    await assert.rejects(sql("set statement_timeout='100ms'; select pg_sleep(1);", alice), /57014/);
  } finally {
    await sql(`alter role authenticated set statement_timeout='8s';
      alter function public.create_robot_room(text) set statement_timeout='5s';
      alter function public.join_robot_room(text,text) set statement_timeout='5s';`);
  }
});

test("contended room admission fails within lock_timeout without a partial membership", async () => {
  const room = await create();
  const code = await roomCode(room.room_id);
  const holder = sql(`set application_name='phase1a-lock-holder'; begin;
    select id from public.rooms where id='${room.room_id}' for update; select pg_sleep(4); commit;`);
  try {
    let locked = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await sql("select exists(select 1 from pg_stat_activity where application_name='phase1a-lock-holder' and wait_event='PgSleep');") === "t") {
        locked = true; break;
      }
    }
    assert.ok(locked, "Holder must acquire the row lock before the admission attempt");
    await denies(`select * from public.join_robot_room('${code}','Bob');`, bob, "55P03");
    assert.equal(await sql("select count(*) from public.room_participants;"), "1");
  } finally { await holder; }
});
