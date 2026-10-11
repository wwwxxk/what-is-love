#!/usr/bin/env python3
"""Offline tests. Never reads a remote URL or credential. Only docker exec/Unix
sockets in --pull=never --network=none tmpfs container; no ports or bind mounts.
Auth/Realtime fixtures are SQL models, NOT actual services or JWT verification.
"""
import concurrent.futures as futures
import hashlib
import json
from pathlib import Path
import subprocess
import threading
import time
import unittest
import uuid
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
MIGRATIONS = ROOT / 'supabase/migrations'
IMAGE = 'postgres@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826'
CONTAINER = 'wil-phase1c-runtime-' + uuid.uuid4().hex[:12]
DB = 'wil_phase1c_test'
A,B,C,D = [f'00000000-0000-4000-8000-{n:012d}' for n in range(1,5)]
OLD = ['20261011000000_room_foundation.sql','20261011010000_room_security_hardening.sql']
NEW = ['20261011020000_room_lifecycle.sql','20261011030000_room_realtime.sql']
FILES = OLD + NEW
INITIAL = {n:hashlib.sha256((MIGRATIONS/n).read_bytes()).hexdigest() for n in FILES}
GIT_BEFORE = subprocess.check_output(['git','status','--porcelain'],cwd=ROOT)
RESULTS = {}
ARTIFACTS = Path(tempfile.mkdtemp(prefix='what-is-love-phase1c-db-'))

def docker(args, stdin=None, check=True):
    r = subprocess.run(['docker',*args],input=stdin,text=True,capture_output=True,timeout=20)
    if check and r.returncode: raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout.strip() if check else r

def psql_args(db=DB,user='postgres'):
    return ['exec','-i',CONTAINER,'psql','-X','-qAt','-U',user,'-d',db,
            '-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']

def lit(v): return "'" + str(v).replace("'","''") + "'"

def context(actor=None,role='authenticated',topic=None):
    s=''
    if actor is not None:
        s+=f"set role {role}; set request.jwt.claim.sub={lit(actor)};\n"
    if topic is not None: s+=f"set realtime.topic={lit(topic)};\n"
    return s

def sql(statement,actor=None,role='authenticated',topic=None,db=DB,user='postgres'):
    return docker(psql_args(db,user),context(actor,role,topic)+statement)

def js(statement,**kwargs): return json.loads(sql(statement,**kwargs))
def rpc(expression,actor): return js(f'select row_to_json(r) from {expression} r;',actor=actor)
def create(actor=A,nickname='Fixture Organizer'):
    v=rpc(f'public.create_robot_room({lit(nickname)})',actor)
    assert v['error_code'] is None,v
    return v
def join(room,actor=B,nickname='Fixture Participant'):
    code=sql(f"select join_code from public.rooms where id={lit(room['room_id'])};")
    return rpc(f'public.join_robot_room({lit(code)},{lit(nickname)})',actor)
def start(room,actor=A): return rpc(f"public.start_robot_room({lit(room['room_id'])})",actor)
def snapshot(room,actor=A): return rpc(f"public.get_robot_room_snapshot({lit(room['room_id'])})",actor)
def state(room): return js(f"select row_to_json(r) from public.rooms r where id={lit(room['room_id'])};")
def messages(): return js("select coalesce(json_agg(m order by topic,id),'[]') from realtime.messages m;")
def topic_for(room,member): return f"wil:room:{room['room_id']}:member:{member['participant_id']}"

def reset():
    sql("truncate public.rooms,auth.users,realtime.messages cascade; "+
        f"insert into auth.users values {','.join('('+lit(x)+')' for x in [A,B,C,D])}; "+
        "update fixture.send_control set fail_on_topic=null;")

def wait_lock(name):
    deadline=time.monotonic()+4
    while time.monotonic()<deadline:
        if sql(f"select count(*) from pg_stat_activity where application_name={lit(name)} "+
               "and wait_event_type='Lock';",user='fixture_admin')=='1': return
        time.sleep(.03)
    raise AssertionError(f'{name} did not wait for the expected database lock')

class Transaction:
    """Deterministic concurrency: keep a real transaction open until released."""
    def __init__(self,statement,actor=None):
        self.p=subprocess.Popen(['docker',*psql_args()],stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
        self.p.stdin.write(context(actor)+'begin;\n'+statement+'\n\\echo LOCK_READY\n')
        self.p.stdin.flush()
        while True:
            if self.p.stdout.readline().strip()=='LOCK_READY': break
            if self.p.poll() is not None: raise RuntimeError(self.p.stderr.read())
    def finish(self,commit=True):
        self.p.stdin.write(('commit;' if commit else 'rollback;')+'\n\\q\n')
        self.p.stdin.flush()
        self.p.stdin.close()
        self.p.wait(timeout=10)
        if self.p.returncode: raise RuntimeError(self.p.stderr.read())
        self.p.stdout.close()
        self.p.stderr.close()

class Validation(unittest.TestCase):
    def setUp(self): reset()
    def denied(self,statement,actor=A,code='42501',**kwargs):
        with self.assertRaisesRegex(RuntimeError,code): sql(statement,actor=actor,**kwargs)
    def unavailable(self,v):
        self.assertEqual(v['error_code'],'room_unavailable')
        self.assertTrue(all(x is None for k,x in v.items() if k!='error_code'),v)

    def test_01_organizer_starts_alone(self):
        room=create()
        self.assertEqual(state(room)['room_version'],'1')
        r=start(room)
        self.assertIsNone(r['error_code'])
        self.assertEqual(r['room_id'],room['room_id'])
        self.assertEqual(r['status'],'task_assignment')
        self.assertEqual(r['room_version'],'2')
        self.assertFalse(r['already_started'])
        self.assertIsNotNone(r['started_at'])
        self.assertEqual(len(snapshot(room)['members']),1)

    def test_02_participant_outsider_creator_mismatch(self):
        room=create()
        member=join(room)
        self.assertIsNone(member['error_code'])
        before=state(room)
        self.assertEqual(start(room,B)['error_code'],'not_organizer')
        self.unavailable(start(room,C))
        self.unavailable(start({'room_id':str(uuid.uuid4())},C))
        self.assertEqual(state(room),before)
        sql(f"update public.room_participants set role='participant' where id={lit(room['participant_id'])}; "+
            f"update public.room_participants set role='organizer' where id={lit(member['participant_id'])};")
        self.assertEqual(start(room,B)['error_code'],'not_organizer')
        self.assertEqual(state(room)['status'],'waiting')

    def test_03_unauthenticated_and_private_function_denials(self):
        room=create()
        for routine in ['start_robot_room','get_robot_room_snapshot']:
            self.denied(f"select * from public.{routine}({lit(room['room_id'])});",actor='',role='anon')
        self.denied(f"select * from public.start_robot_room({lit(room['room_id'])});",actor='',code='28000')
        self.unavailable(snapshot(room,''))
        for routine in ['advance_room_version()','invalidate_room_membership()','broadcast_room_change()']:
            self.denied(f'select room_private.{routine};')

    def test_04_idempotence_and_inconsistent_states(self):
        room=create()
        first=start(room)
        before,before_msgs=state(room),messages()
        repeated=start(room)
        self.assertTrue(repeated['already_started'])
        self.assertEqual({k:v for k,v in first.items() if k!='already_started'},
                         {k:v for k,v in repeated.items() if k!='already_started'})
        self.assertEqual(state(room),before)
        self.assertEqual(messages(),before_msgs)
        sql(f"update public.rooms set status='conversation' where id={lit(room['room_id'])};")
        later=state(room)
        self.assertTrue(start(room)['already_started'])
        self.assertEqual(start(room)['status'],'conversation')
        self.assertEqual(state(room),later)
        sql(f"update public.rooms set status='waiting' where id={lit(room['room_id'])};")
        self.assertEqual(start(room)['error_code'],'invalid_room_state')
        sql(f"update public.rooms set status='task_assignment',started_at=null where id={lit(room['room_id'])};")
        invalid=state(room)
        self.assertEqual(start(room)['error_code'],'invalid_room_state')
        self.assertEqual(state(room),invalid)

    def test_05_snapshot_rls_direct_mutations_recovery(self):
        room=create()
        member=join(room)
        other=create(C,'Other Room')
        for actor in [A,B]:
            snap=snapshot(room,actor)
            self.assertIsNone(snap['error_code'])
            self.assertEqual(snap['room']['id'],room['room_id'])
            self.assertEqual(len(snap['members']),2)
            self.assertEqual(snap['room_version'],snap['room']['room_version'])
            self.assertEqual(snap['participant_id'],room['participant_id'] if actor==A else member['participant_id'])
        self.unavailable(snapshot(room,C))
        self.unavailable(snapshot(other,A))
        self.unavailable(snapshot({'room_id':str(uuid.uuid4())},A))
        self.assertEqual(sql(f"select count(*) from public.rooms where id={lit(room['room_id'])};",actor=C),'0')
        self.assertEqual(sql(f"select count(*) from public.room_participants where room_id={lit(room['room_id'])};",actor=C),'0')
        self.denied(f"update public.rooms set status='finished' where id={lit(room['room_id'])};",actor=B)
        self.denied(f"update public.room_participants set role='organizer' where id={lit(member['participant_id'])};",actor=B)
        self.denied(f"update public.room_participants set auth_user_id={lit(C)} where id={lit(room['participant_id'])};",actor=B)
        start(room)
        recovered=join(room,B,'Should Not Replace Name')
        self.assertEqual(recovered['participant_id'],member['participant_id'])
        self.assertEqual(snapshot(room,B)['room']['status'],'task_assignment')
        self.assertEqual(snapshot(room,B)['room_version'],'3')
        self.unavailable(join(room,D))

    def test_06_version_changes(self):
        room=create()
        sql(f"update public.rooms set updated_at=now() where id={lit(room['room_id'])};")
        self.assertEqual(state(room)['room_version'],'1')
        sql(f"update public.rooms set room_version='999999' where id={lit(room['room_id'])};")
        self.assertEqual(state(room)['room_version'],'2')
        member=join(room)
        self.assertEqual(state(room)['room_version'],'3')
        join(room)
        self.assertEqual(state(room)['room_version'],'3')
        sql(f"update public.room_participants set nickname=nickname,updated_at=now() where id={lit(member['participant_id'])};")
        self.assertEqual(state(room)['room_version'],'3')
        sql(f"update public.room_participants set nickname='Changed Fixture' where id={lit(member['participant_id'])};")
        self.assertEqual(state(room)['room_version'],'4')
        sql(f"delete from public.room_participants where id={lit(member['participant_id'])};")
        self.assertEqual(state(room)['room_version'],'5')
        sql(f"delete from public.rooms where id={lit(room['room_id'])};")
        self.assertEqual(sql('select count(*) from public.room_participants;'),'0')

    def test_07_version_constraints_precision_overflow(self):
        for value in ['-1','00','01','1.0',' 1','9223372036854775808','wat']:
            self.denied("insert into public.rooms(join_code,created_by,room_version) "+
                f"values ('ABCDEFGHJKLM',{lit(A)},{lit(value)});",actor=None,code='23514')
        room=create()
        sql(f"alter table public.rooms disable trigger rooms_advance_version; "+
            f"update public.rooms set room_version='9007199254740992' where id={lit(room['room_id'])}; "+
            "alter table public.rooms enable trigger rooms_advance_version;")
        self.assertEqual(start(room)['room_version'],'9007199254740993')
        self.assertIsInstance(snapshot(room)['room']['room_version'],str)
        sql(f"alter table public.rooms disable trigger rooms_advance_version; "+
            f"update public.rooms set room_version='9223372036854775807' where id={lit(room['room_id'])}; "+
            "alter table public.rooms enable trigger rooms_advance_version;")
        before=state(room)
        self.denied(f"update public.rooms set status='conversation' where id={lit(room['room_id'])};",actor=None,code='22003')
        self.assertEqual(state(room),before)

    def test_08_concurrent_starts(self):
        room=create()
        sql('truncate realtime.messages;')
        barrier=threading.Barrier(8)
        def call(_):
            barrier.wait(timeout=5)
            return start(room)
        with futures.ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(call,range(8)))
        self.assertTrue(all(r['error_code'] is None for r in results))
        self.assertEqual(sum(not r['already_started'] for r in results),1)
        self.assertEqual(len({r['started_at'] for r in results}),1)
        self.assertEqual({r['room_version'] for r in results},{'2'})
        self.assertEqual(len(messages()),1)

    def test_09_join_first_then_start(self):
        room=create()
        code=sql(f"select join_code from public.rooms where id={lit(room['room_id'])};")
        held=Transaction(f"select * from public.join_robot_room({lit(code)},'Race Member');",B)
        try:
            with futures.ThreadPoolExecutor() as pool:
                pending=pool.submit(sql,"set application_name='wil-start-after-join'; "+
                    f"select row_to_json(r) from public.start_robot_room({lit(room['room_id'])}) r;",A)
                wait_lock('wil-start-after-join')
                held.finish()
                r=json.loads(pending.result(timeout=10))
                self.assertIsNone(r['error_code'])
                self.assertEqual(r['room_version'],'3')
        finally:
            if held.p.poll() is None: held.finish(False)
        self.assertEqual(len(snapshot(room,B)['members']),2)
        self.assertEqual(state(room)['status'],'task_assignment')

    def test_10_start_first_then_join(self):
        room=create()
        code=sql(f"select join_code from public.rooms where id={lit(room['room_id'])};")
        held=Transaction(f"select * from public.start_robot_room({lit(room['room_id'])});",A)
        try:
            with futures.ThreadPoolExecutor() as pool:
                pending=pool.submit(sql,"set application_name='wil-join-after-start'; "+
                    f"select row_to_json(r) from public.join_robot_room({lit(code)},'Too Late') r;",B)
                wait_lock('wil-join-after-start')
                held.finish()
                self.unavailable(json.loads(pending.result(timeout=10)))
        finally:
            if held.p.poll() is None: held.finish(False)
        self.assertEqual(len(snapshot(room)['members']),1)
        self.assertEqual(state(room)['room_version'],'2')

    def test_11_membership_recheck_after_lock(self):
        room=create()
        held=Transaction(f"select id from public.rooms where id={lit(room['room_id'])} for update; "+
            f"delete from public.room_participants where id={lit(room['participant_id'])};")
        try:
            with futures.ThreadPoolExecutor() as pool:
                pending=pool.submit(sql,"set application_name='wil-revoked-start'; "+
                    f"select row_to_json(r) from public.start_robot_room({lit(room['room_id'])}) r;",A)
                wait_lock('wil-revoked-start')
                held.finish()
                self.unavailable(json.loads(pending.result(timeout=10)))
        finally:
            if held.p.poll() is None: held.finish(False)
        self.assertEqual(state(room)['status'],'waiting')
        self.unavailable(snapshot(room))

    def test_12_duplicate_joins_and_organizer_recovery_race(self):
        room=create()
        barrier=threading.Barrier(6)
        def call(_):
            barrier.wait(timeout=5)
            return join(room)
        with futures.ThreadPoolExecutor(max_workers=6) as pool:
            results=list(pool.map(call,range(6)))
        self.assertTrue(all(r['error_code'] is None for r in results))
        self.assertEqual(len({r['participant_id'] for r in results}),1)
        self.assertEqual(state(room)['room_version'],'2')
        with futures.ThreadPoolExecutor() as pool:
            results=[pool.submit(start,room),pool.submit(join,room,A)]
            self.assertTrue(all(r.result()['error_code'] is None for r in results))
        self.assertEqual(state(room)['room_version'],'3')

    def test_13_trigger_failure_start_rollback(self):
        room=create()
        member=join(room)
        last=max(room['participant_id'],member['participant_id'])
        failing=f"wil:room:{room['room_id']}:member:{last}"
        sql(f"update fixture.send_control set fail_on_topic={lit(failing)};")
        before,before_msgs=state(room),messages()
        self.denied(f"select * from public.start_robot_room({lit(room['room_id'])});",code='Injected local publisher failure')
        self.assertEqual(state(room),before)
        self.assertEqual(messages(),before_msgs)
        sql('update fixture.send_control set fail_on_topic=null;')
        self.assertIsNone(start(room)['error_code'])

    def test_14_trigger_failure_join_rollback(self):
        room=create()
        sql(f"update fixture.send_control set fail_on_topic={lit(topic_for(room,room))};")
        before,before_msgs=state(room),messages()
        with self.assertRaisesRegex(RuntimeError,'Injected local publisher failure'): join(room)
        self.assertEqual(state(room),before)
        self.assertEqual(messages(),before_msgs)
        self.assertEqual(sql(f"select count(*) from public.room_participants where auth_user_id={lit(B)};"),'0')
        self.assertEqual(sql(f"select count(*) from room_private.room_request_budgets where auth_user_id={lit(B)};"),'0')

    def test_15_membership_topic_sql_authorization(self):
        room=create()
        member=join(room)
        other=create(C,'Other Room')
        sql('truncate realtime.messages;')
        start(room)
        start(other,C)
        at,bt=topic_for(room,room),topic_for(room,member)
        for actor,own in [(A,at),(B,bt)]:
            visible=js("select coalesce(json_agg(m),'[]') from realtime.messages m;",actor=actor,topic=own)
            self.assertEqual(len(visible),1)
            self.assertEqual(visible[0]['topic'],own)
        for actor,topic in [(A,bt),(B,at),(C,at),(D,at),(D,bt),('',at)]:
            self.assertEqual(sql('select count(*) from realtime.messages;',actor=actor,topic=topic),'0')
        for malformed in ['', 'wil:room:bad:member:bad',at+'suffix',at.upper(),at.replace(':member:',':')]:
            self.assertEqual(sql('select count(*) from realtime.messages;',actor=A,topic=malformed),'0')

    def test_16_restrictive_guards_with_adversarial_broad_policies(self):
        room=create()
        own=topic_for(room,room)
        sql('grant insert,update,delete on realtime.messages to authenticated,anon;',user='fixture_admin')
        sql('create policy fixture_broad on realtime.messages for all to public using(true) with check(true);',user='fixture_admin')
        try:
            for actor,role in [(A,'authenticated'),(B,'authenticated'),('','anon')]:
                self.denied(f"insert into realtime.messages(topic,extension,payload,event) values ({lit(own)},'broadcast','{{}}','fake');",actor=actor,role=role,topic=own)
                self.denied("insert into realtime.messages(topic,extension) values ('unrelated','broadcast');",actor=actor,role=role,topic=own)
                for mutation in [
                    f"update realtime.messages set payload='{{}}' where topic={lit(own)} returning id;",
                    f"delete from realtime.messages where topic={lit(own)} returning id;"
                ]:
                    self.assertEqual(sql(mutation,actor=actor,role=role,topic=own),'')
            self.assertEqual(sql('select count(*) from realtime.messages;',actor=B,topic=own),'0')
            sql(f"insert into realtime.messages(topic,extension) values ({lit(own)},'presence');")
            self.assertEqual(sql("select count(*) from realtime.messages where extension='presence';",actor=A,topic=own),'0')
            sql("insert into realtime.messages(topic,extension) values ('unrelated','broadcast');",actor=A,topic='unrelated')
            self.assertEqual(sql("select count(*) from realtime.messages where topic='unrelated';",actor=A,topic='unrelated'),'1')
        finally:
            sql('drop policy fixture_broad on realtime.messages; revoke insert,update,delete on realtime.messages from authenticated,anon;',user='fixture_admin')

    def test_17_payload_fanout_and_revocation(self):
        room=create()
        member=join(room)
        at,bt=topic_for(room,room),topic_for(room,member)
        sql('truncate realtime.messages;')
        started=start(room)
        for msg in messages():
            self.assertEqual(msg['payload'],{'room_version':started['room_version']})
            self.assertEqual(msg['extension'],'broadcast')
            self.assertEqual(msg['event'],'room_changed')
            self.assertTrue(msg['private'])
        self.assertEqual({m['topic'] for m in messages()},{at,bt})
        sql(f"delete from public.room_participants where id={lit(member['participant_id'])};")
        self.assertEqual(state(room)['room_version'],'4')
        after=messages()
        self.assertEqual([m['topic'] for m in after if m['payload']['room_version']=='4'],[at])
        self.assertEqual(sql('select count(*) from realtime.messages;',actor=B,topic=bt),'0')
        self.unavailable(snapshot(room,B))
        # Routing topics necessarily contain room/membership UUIDs. Payloads must
        # contain no member UUID, auth UUID, nickname, invitation code, or list.
        for msg in after:
            for forbidden in [state(room)['join_code'],'Fixture Organizer','Fixture Participant',A,B,room['participant_id'],member['participant_id']]:
                self.assertNotIn(forbidden,json.dumps(msg['payload']))

    def test_18_timeout_caps_and_ownership(self):
        self.assertEqual(sql("select rolsuper from pg_roles where rolname='postgres';"),'f')
        self.assertEqual(sql("select rolconfig::text from pg_roles where rolname='authenticated';"),'{statement_timeout=8s}')
        metadata=js("select json_agg(json_build_object('name',proname,'definer',prosecdef,'owner',pg_get_userbyid(proowner),'config',proconfig)) from pg_proc "+
            "where oid in ('public.get_robot_room_snapshot(uuid)'::regprocedure,'public.start_robot_room(uuid)'::regprocedure);")
        for item in metadata:
            self.assertEqual(item['owner'],'postgres')
            self.assertEqual(item['definer'],item['name']=='start_robot_room')
            self.assertIn('search_path=""',item['config'])
            self.assertIn('statement_timeout=5000ms',item['config'])
            self.assertIn('lock_timeout=2000ms',item['config'])

    def test_19_lock_timeout_rollback(self):
        room=create()
        before=state(room)
        held=Transaction(f"select id from public.rooms where id={lit(room['room_id'])} for update;")
        try:
            self.denied(f"select * from public.start_robot_room({lit(room['room_id'])});",code='55P03')
        finally: held.finish(False)
        self.assertEqual(state(room),before)

    def test_20_membership_move_invalidates_both_rooms(self):
        room=create()
        member=join(room)
        other=create(C,'Other Room')
        sql(f"begin; select id from public.rooms where id in ({lit(room['room_id'])},{lit(other['room_id'])}) order by id for update; "+
            f"update public.room_participants set room_id={lit(other['room_id'])} where id={lit(member['participant_id'])}; commit;")
        self.assertEqual(state(room)['room_version'],'3')
        self.assertEqual(state(other)['room_version'],'2')
        self.unavailable(snapshot(room,B))
        self.assertEqual(snapshot(other,B)['participant_id'],member['participant_id'])

    def test_21_unrelated_anon_namespace_compatibility(self):
        # Required coexistence property from draft comments/review: policies for
        # unrelated topics retain their behavior. This is intentionally a real
        # regression assertion; must succeed with the new helper.
        sql("create policy fixture_anon_other on realtime.messages for select to anon using(topic='unrelated');",user='fixture_admin')
        sql("insert into realtime.messages(topic,extension) values ('unrelated','broadcast');")
        try:
            # Prove the established unrelated policy works without our guard.
            # DROP is transactionally rolled back; draft source is never edited.
            control=sql("begin; drop policy wil_room_broadcast_read_guard on realtime.messages; "+
                "set role anon; set request.jwt.claim.sub=''; set realtime.topic='unrelated'; "+
                "select count(*) from realtime.messages where topic='unrelated'; reset role; rollback;")
            self.assertEqual(control,'1')
            RESULTS['anon_unrelated_control_without_guard']='PASS; same unrelated policy returns one row'
            self.assertEqual(sql("select count(*) from realtime.messages where topic='unrelated';",
                                 actor='',role='anon',topic='unrelated'),'1')
        finally:
            sql('drop policy fixture_anon_other on realtime.messages;',user='fixture_admin')

    def test_22_client_cannot_invoke_private_or_public_publisher(self):
        room=create()
        own=topic_for(room,room)
        self.denied(f"select realtime.send('{{}}','fake',{lit(own)},true);",topic=own)
        # Adversarially grant the platform invoker function to authenticated and
        # remove fixture-only control-table privilege as a confounding factor.
        sql("grant execute on function realtime.send(jsonb,text,text,boolean) to authenticated; "+
            "grant usage on schema fixture to authenticated; "+
            "grant select on fixture.send_control to authenticated; "+
            "grant insert on realtime.messages to authenticated; "+
            "create policy fixture_publisher on realtime.messages for insert to authenticated with check(true);",user='fixture_admin')
        before=messages()
        try:
            self.denied(f"select realtime.send('{{}}','fake',{lit(own)},true);",topic=own,code='new row violates row-level security')
            self.assertEqual(messages(),before)
        finally:
            sql("drop policy fixture_publisher on realtime.messages; "+
                "revoke execute on function realtime.send(jsonb,text,text,boolean) from authenticated; "+
                "revoke usage on schema fixture from authenticated; "+
                "revoke select on fixture.send_control from authenticated; "+
                "revoke insert on realtime.messages from authenticated;",user='fixture_admin')

    def test_23_trigger_failure_create_rollback(self):
        # Inject a row-trigger exception before the organizer insert; all room,
        # membership, request-budget, and notification changes must roll back.
        sql("create function fixture.reject_membership() returns trigger language plpgsql as $$ "+
            "begin raise exception 'Injected membership failure'; end; $$; "+
            "create trigger fixture_reject before insert on public.room_participants "+
            "for each row execute function fixture.reject_membership();")
        try:
            with self.assertRaisesRegex(RuntimeError,'Injected membership failure'): create()
            for table in ['public.rooms','public.room_participants','room_private.room_request_budgets','realtime.messages']:
                self.assertEqual(sql(f'select count(*) from {table};'),'0')
        finally:
            sql('drop trigger fixture_reject on public.room_participants; drop function fixture.reject_membership();')

    def test_24_snapshot_one_mvcc_statement(self):
        room=create()
        # A committed snapshot cannot mix uncommitted room state with committed
        # memberships. After commit both change together, under actual table RLS.
        code=sql(f"select join_code from public.rooms where id={lit(room['room_id'])};")
        held=Transaction(f"select * from public.join_robot_room({lit(code)},'MVCC Member');",B)
        try:
            snap=snapshot(room)
            self.assertEqual(snap['room_version'],'1')
            self.assertEqual(len(snap['members']),1)
            held.finish()
        finally:
            if held.p.poll() is None: held.finish(False)
        snap=snapshot(room)
        self.assertEqual(snap['room_version'],'2')
        self.assertEqual(len(snap['members']),2)

    def test_25_unrelated_authenticated_and_anon_reads_no_extra_access(self):
        room=create()
        own=topic_for(room,room)
        sql("insert into realtime.messages(topic,extension) values ('unrelated','broadcast');")
        # No established permissive policy => unrelated rows remain denied.
        for actor,role in [(A,'authenticated'),('','anon')]:
            self.assertEqual(sql("select count(*) from realtime.messages where topic='unrelated';",
                actor=actor,role=role,topic='unrelated'),'0')
        sql("create policy fixture_outside on realtime.messages for select to public using(topic='unrelated');",user='fixture_admin')
        try:
            for actor,role in [(A,'authenticated'),(B,'authenticated'),('','anon')]:
                self.assertEqual(sql("select count(*) from realtime.messages where topic='unrelated';",
                    actor=actor,role=role,topic='unrelated'),'1')
                # An unrelated row cannot be used to authorize an app context.
                self.assertEqual(sql("select count(*) from realtime.messages where topic='unrelated';",
                    actor=actor,role=role,topic=own),'0')
        finally: sql('drop policy fixture_outside on realtime.messages;',user='fixture_admin')

    def test_26_helper_owner_acl_and_no_record_exposure(self):
        metadata=js("select json_build_object('owner',pg_get_userbyid(proowner),'definer',prosecdef,"+
            "'stable',provolatile='s','config',proconfig,'result',pg_get_function_result(oid)) "+
            "from pg_proc where oid='room_private.owns_room_broadcast_topic(text)'::regprocedure;")
        self.assertEqual(metadata['owner'],'postgres')
        self.assertTrue(metadata['definer'])
        self.assertTrue(metadata['stable'])
        self.assertEqual(metadata['result'],'boolean')
        self.assertIn('search_path=""',metadata['config'])
        for role in ['anon','authenticated']:
            self.assertEqual(sql(f"select has_function_privilege({lit(role)},'room_private.owns_room_broadcast_topic(text)','EXECUTE');"),'t')
        self.assertEqual(sql("select has_table_privilege('anon','public.room_participants','SELECT');"),'f')
        self.assertEqual(sql("select has_table_privilege('authenticated','public.room_participants','SELECT');"),'t')
        self.assertEqual(sql("select has_schema_privilege('anon','room_private','USAGE');"),'f')
        self.assertEqual(sql("select has_table_privilege('authenticated','public.room_participants','INSERT,UPDATE,DELETE');"),'f')
        for role in ['anon','authenticated']:
            for table in ['room_private.room_limits','room_private.room_request_budgets']:
                self.assertEqual(sql(f"select has_table_privilege({lit(role)},{lit(table)},'SELECT,INSERT,UPDATE,DELETE');"),'f')
        room=create()
        own=topic_for(room,room)
        self.assertEqual(sql(f"select room_private.owns_room_broadcast_topic({lit(own)});",actor=A),'t')
        self.assertEqual(sql(f"select room_private.owns_room_broadcast_topic({lit(own)});",actor=B),'f')
        self.assertEqual(sql(f"select room_private.owns_room_broadcast_topic({lit(own)});",actor=''),'f')
        # An additional actor argument cannot be supplied through an overload.
        self.denied(f"select room_private.owns_room_broadcast_topic({lit(own)},{lit(A)});",actor=B,code='42883')
        # PUBLIC execute adds no name-lookup/schema privilege to anon.
        self.denied(f"select room_private.owns_room_broadcast_topic({lit(own)});",actor='',role='anon')

    def test_27_missing_null_jwt_and_hostile_topics(self):
        room=create()
        member=join(room)
        other=create(C,'Other Room')
        sql('truncate realtime.messages;')
        start(room)
        at,bt=topic_for(room,room),topic_for(room,member)
        sql('create policy fixture_all_reads on realtime.messages for select to public using(true);',user='fixture_admin')
        try:
            # Missing sub, explicitly empty sub, absent topic context and SQL NULL
            # are safe and return zero rows rather than ACL/cast errors.
            for role in ['anon','authenticated']:
                self.assertEqual(sql(f"set role {role}; set realtime.topic={lit(at)}; select count(*) from realtime.messages;"),'0')
                self.assertEqual(sql('select count(*) from realtime.messages;',actor='',role=role,topic=at),'0')
            self.assertEqual(sql("select room_private.owns_room_broadcast_topic(null);",actor=A),'f')
            self.assertEqual(sql("select count(*) from realtime.messages;",actor=A),'0')
            hostile=[at+'suffix',at+' ',at.upper(),at.replace(':member:',':member:bad'),
                'wil:room::member:',"wil:room:'; select 1; --", 'wil:room:'+'x'*10000,
                f"wil:room:{other['room_id']}:member:{room['participant_id']}",
                f"wil:room:{room['room_id']}:member:{other['participant_id']}",
                at.replace(room['participant_id'],A),bt]
            for topic in hostile:
                self.assertEqual(sql(f"select room_private.owns_room_broadcast_topic({lit(topic)});",actor=A),'f')
                self.assertEqual(sql('select count(*) from realtime.messages;',actor=A,topic=topic),'0')
            for actor in [C,D]:
                self.assertEqual(sql('select count(*) from realtime.messages;',actor=actor,topic=at),'0')
        finally: sql('drop policy fixture_all_reads on realtime.messages;',user='fixture_admin')

    def test_28_other_ordinary_role_has_no_policy_permission_errors(self):
        # A PUBLIC guard also covers non-API roles with established unrelated
        # readers. Narrowing helper EXECUTE to anon/authenticated would break this.
        sql("create role fixture_reader nologin; "+
            "grant usage on schema realtime to fixture_reader; "+
            "grant select on realtime.messages to fixture_reader; "+
            "grant execute on function realtime.topic() to fixture_reader; "+
            "create policy fixture_reader_policy on realtime.messages for select to fixture_reader using(true);",
            user='fixture_admin')
        room=create()
        own=topic_for(room,room)
        sql("insert into realtime.messages(topic,extension) values ('unrelated','broadcast');")
        try:
            self.assertEqual(sql("select has_table_privilege('fixture_reader','public.room_participants','SELECT');"),'f')
            self.assertEqual(sql("select has_function_privilege('fixture_reader','room_private.owns_room_broadcast_topic(text)','EXECUTE');"),'t')
            self.assertEqual(sql("set role fixture_reader; set realtime.topic='unrelated'; select count(*) from realtime.messages;",
                                 user='fixture_admin'),'1')
            self.assertEqual(sql(f"set role fixture_reader; set realtime.topic={lit(own)}; select count(*) from realtime.messages;",
                                 user='fixture_admin'),'0')
        finally:
            sql('drop policy fixture_reader_policy on realtime.messages; revoke all on realtime.messages from fixture_reader; '+
                'revoke all on schema realtime from fixture_reader; revoke all on function realtime.topic() from fixture_reader; '+
                'drop role fixture_reader;',user='fixture_admin')

    def test_29_no_recursive_rls_and_membership_bound_decision(self):
        room=create()
        member=join(room)
        other=create(C,'Other Room')
        at,bt=topic_for(room,room),topic_for(room,member)
        # Helper need not run member RLS, which calls the existing membership
        # helper. Check table policy inventory unchanged and both readers work.
        self.assertEqual(sql("select count(*) from pg_policies where schemaname='public' and tablename in ('rooms','room_participants');"),'2')
        for actor,own in [(A,at),(B,bt)]:
            self.assertEqual(sql(f"select room_private.owns_room_broadcast_topic({lit(own)});",actor=actor),'t')
            self.assertIsNone(snapshot(room,actor)['error_code'])
        forged=f"wil:room:{other['room_id']}:member:{member['participant_id']}"
        self.assertEqual(sql(f"select room_private.owns_room_broadcast_topic({lit(forged)});",actor=B),'f')
        sql(f"delete from public.room_participants where id={lit(member['participant_id'])};")
        self.assertEqual(sql(f"select room_private.owns_room_broadcast_topic({lit(bt)});",actor=B),'f')
        self.assertEqual(sql('select count(*) from realtime.messages;',actor=B,topic=bt),'0')
        self.unavailable(snapshot(room,B))

    def test_30_existing_permissive_policies_do_not_open_app_channels(self):
        room=create()
        member=join(room)
        at,bt=topic_for(room,room),topic_for(room,member)
        sql('create policy fixture_broad_existing on realtime.messages for select to public using(true);',user='fixture_admin')
        before=messages()
        try:
            self.assertGreater(int(sql('select count(*) from realtime.messages;',actor=A,topic=at)),0)
            for actor,role in [(B,'authenticated'),(C,'authenticated'),('','anon')]:
                self.assertEqual(sql('select count(*) from realtime.messages;',actor=actor,role=role,topic=at),'0')
            self.assertEqual(sql('select count(*) from realtime.messages;',actor=A,topic=bt),'0')
            # Same own topic with extension presence must not authorize a row.
            sql(f"insert into realtime.messages(topic,extension) values ({lit(at)},'presence');")
            self.assertEqual(sql("select count(*) from realtime.messages where extension='presence';",actor=A,topic=at),'0')
        finally: sql('drop policy fixture_broad_existing on realtime.messages;',user='fixture_admin')

    def test_31_migration_accepts_preexisting_permissive_policies_safely(self):
        db='wil_permissive_before_migration'
        sql(f'create database {db} owner postgres template wil_phase1a_template;',user='fixture_admin')
        try:
            sql((MIGRATIONS/NEW[0]).read_text(),db=db)
            sql('create policy fixture_preexisting on realtime.messages for all to public using(true) with check(true); '+
                'grant insert on realtime.messages to authenticated,anon;',db=db,user='fixture_admin')
            sql((MIGRATIONS/NEW[1]).read_text(),db=db)
            sql(f"insert into auth.users values ({lit(A)}),({lit(B)});",db=db)
            room=js("select row_to_json(r) from public.create_robot_room('Existing Policies') r;",actor=A,db=db)
            own=topic_for(room,room)
            self.assertIsNone(room['error_code'])
            self.assertEqual(sql('select count(*) from realtime.messages;',actor=A,topic=own,db=db),'1')
            for actor,role in [(B,'authenticated'),('','anon')]:
                self.assertEqual(sql('select count(*) from realtime.messages;',actor=actor,role=role,topic=own,db=db),'0')
                self.denied(f"insert into realtime.messages(topic,extension) values ({lit(own)},'broadcast');",
                            actor=actor,role=role,topic=own,db=db,code='new row violates row-level security')
            sql("insert into realtime.messages(topic,extension) values ('unrelated','broadcast');",db=db)
            for actor,role in [(A,'authenticated'),('','anon')]:
                self.assertEqual(sql('select count(*) from realtime.messages;',actor=actor,role=role,topic='unrelated',db=db),'1')
        finally: sql(f'drop database {db};',user='fixture_admin')

def install():
    docker(['run','--detach','--rm','--pull=never','--name',CONTAINER,'--network','none',
        '--tmpfs','/var/lib/postgresql/data:rw,size=256m','--label','what-is-love.phase1c-test=true',
        '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=fixture_admin',
        '-e',f'POSTGRES_DB={DB}',IMAGE])
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        try:
            if sql('select 1;',user='fixture_admin')=='1': break
        except RuntimeError: time.sleep(.1)
    else: raise RuntimeError('Actual local test database did not become ready')
    RESULTS['environment']=js("select json_build_object('version',version(),'database',current_database());",user='fixture_admin')
    RESULTS['container_isolation']=json.loads(docker(['inspect','--format','{{json .HostConfig}}',CONTAINER]))
    sql((HERE/'phase1c-platform.sql').read_text(),user='fixture_admin')
    sql(f'alter database {DB} owner to postgres;',user='fixture_admin')
    for name in OLD: sql((MIGRATIONS/name).read_text())
    sql(f'create database wil_phase1a_template owner postgres template {DB};',user='fixture_admin')
    reset()
    legacy=create()
    join(legacy)
    before=state(legacy)
    started_legacy=create(C,'Legacy Started Organizer')
    sql(f"update public.rooms set status='conversation',started_at=clock_timestamp() where id={lit(started_legacy['room_id'])};")
    started_before=state(started_legacy)
    sql((MIGRATIONS/NEW[0]).read_text())
    after=state(legacy)
    assert after.pop('room_version')=='0'
    assert before==after,(before,after)
    assert len(snapshot(legacy,B)['members'])==2
    started_after=state(started_legacy)
    assert started_after.pop('room_version')=='0'
    assert started_before==started_after
    assert start(started_legacy,C)['already_started'] is True
    RESULTS['lifecycle_migration']='executed unchanged; existing room/memberships preserved, revision 0'
    sql((MIGRATIONS/NEW[1]).read_text())
    RESULTS['realtime_migration']='executed unchanged against explicit SQL test fixture'

def prerequisite_tests():
    outcomes=[]
    cases=[
        ('missing authenticated realtime SELECT','revoke select on realtime.messages from authenticated;','Required platform privileges are absent'),
        ('existing restrictive realtime SELECT','create policy incompatible on realtime.messages as restrictive for select to authenticated using(false);','Existing restrictive Realtime read policies'),
        ('publisher lacks inherited INSERT','grant usage on schema realtime to postgres; revoke supabase_realtime_admin from postgres;','Trusted database publisher cannot bypass'),
    ]
    for i,(name,change,expected) in enumerate(cases):
        db=f'wil_guard_{i}'
        sql(f'create database {db} owner postgres template wil_phase1a_template;',user='fixture_admin')
        sql((MIGRATIONS/NEW[0]).read_text(),db=db)
        sql(change,db=db,user='fixture_admin')
        try:
            try: sql((MIGRATIONS/NEW[1]).read_text(),db=db)
            except RuntimeError as err: assert expected in str(err),str(err)
            else: raise AssertionError('Unsafe prerequisite unexpectedly accepted')
            assert sql("select to_regprocedure('room_private.broadcast_room_change()') is null;",db=db)=='t'
            assert sql("select count(*) from pg_policies where tablename='messages' and policyname like 'wil_%';",db=db)=='0'
            outcomes.append({'name':name,'result':'PASS; no partial migration objects'})
        finally:
            if i==2: sql('grant supabase_realtime_admin to postgres;',user='fixture_admin')
            sql(f'drop database {db};',user='fixture_admin')
    db='wil_tighter_timeouts'
    sql(f'create database {db} owner postgres template wil_phase1a_template;',user='fixture_admin')
    sql(f"alter role authenticated in database {db} set statement_timeout='3s'; "+
        f"alter role authenticated in database {db} set lock_timeout='500ms';",user='fixture_admin')
    sql((MIGRATIONS/NEW[0]).read_text(),db=db)
    cfg=sql("select proconfig::text from pg_proc where oid='public.start_robot_room(uuid)'::regprocedure;",db=db)
    assert 'statement_timeout=3000ms' in cfg and 'lock_timeout=500ms' in cfg,cfg
    assert sql("select rolconfig::text from pg_roles where rolname='authenticated';")=='{statement_timeout=8s}'
    outcomes.append({'name':'stricter database/role timeout retention','result':'PASS; 3s/500ms, global role stays 8s'})
    sql(f'drop database {db};',user='fixture_admin')
    RESULTS['prerequisites']=outcomes

class RecordingResult(unittest.TextTestResult):
    def addSuccess(self,test):
        super().addSuccess(test)
        RESULTS.setdefault('tests',[]).append({'name':test._testMethodName,'result':'PASS'})
    def addFailure(self,test,err):
        super().addFailure(test,err)
        RESULTS.setdefault('tests',[]).append({'name':test._testMethodName,'result':'FAIL','detail':self._exc_info_to_string(err,test)})
    def addError(self,test,err):
        super().addError(test,err)
        RESULTS.setdefault('tests',[]).append({'name':test._testMethodName,'result':'ERROR','detail':self._exc_info_to_string(err,test)})

if __name__=='__main__':
    success=False
    try:
        install()
        prerequisite_tests()
        result=unittest.TextTestRunner(verbosity=2,resultclass=RecordingResult).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(Validation))
        success=result.wasSuccessful()
        RESULTS['summary']={'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors)}
    except Exception as err:
        RESULTS['setup_error']=str(err)
        print('SETUP ERROR:',err,flush=True)
    finally:
        RESULTS['container_removed']=docker(['rm','--force',CONTAINER],check=False).returncode==0
        final={n:hashlib.sha256((MIGRATIONS/n).read_bytes()).hexdigest() for n in FILES}
        RESULTS['migration_hashes']=final
        RESULTS['migration_sources_unchanged']=INITIAL==final
        RESULTS['git_status_unchanged']=GIT_BEFORE==subprocess.check_output(['git','status','--porcelain'],cwd=ROOT)
        (ARTIFACTS/'results.json').write_text(json.dumps(RESULTS,indent=2)+'\n')
        print('Report:',ARTIFACTS/'results.json',flush=True)
    raise SystemExit(0 if success else 1)
