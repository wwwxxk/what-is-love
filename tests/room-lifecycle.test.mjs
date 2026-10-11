import assert from "node:assert/strict";
import test from "node:test";
import { getRoomSnapshot, startRoom, isRoomVersion, compareRoomVersions } from "../src/features/rooms/lifecycle.ts";
import { createRoomSynchronization, membershipTopic, canStartTraining } from "../src/features/rooms/synchronization.ts";
import { roomRealtimeTransport } from "../src/features/rooms/realtime.ts";
import { RoomOperationError } from "../src/features/rooms/data-access.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const roomId = "00000000-0000-4000-8000-000000000010";
const memberId = "00000000-0000-4000-8000-000000000020";
const stamp = "2026-10-11T00:00:00Z";
function fixture(version = "1", status = "waiting", role = "organizer") {
  const participant = { id: memberId, room_id: roomId, auth_user_id: userId, nickname: "River", role, joined_at: stamp, updated_at: stamp };
  return { kind: "ready", identity: { userId, isAnonymous: true },
    room: { id: roomId, join_code: "ABCDEFGHJKLM", status, created_by: userId, created_at: stamp, updated_at: stamp,
      started_at: status === "waiting" ? null : stamp, room_version: version },
    participant, members: [participant], version };
}
function raw(snapshot = fixture()) {
  return { room: snapshot.room, participant_id: snapshot.participant.id, members: snapshot.members, room_version: snapshot.version, error_code: null };
}
function client(data, users = [userId], error = null) {
  let verified = 0;
  const calls = [];
  const value = { calls, auth: {
    getUser: async () => {
      const id = users[Math.min(verified++, users.length - 1)];
      return { data: { user: id ? { id, is_anonymous: true } : null }, error: null };
    },
    signInAnonymously: () => assert.fail("Recovery must never sign up"),
    getSession: () => assert.fail("Session content must not authorize"),
  }, rpc(name, args) {
    calls.push({ name, args });
    return { abortSignal() { return this; }, single: async () => ({ data, error }) };
  } };
  return value;
}
const started = { room_id: roomId, status: "task_assignment", started_at: stamp, room_version: "2", already_started: false, error_code: null };
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function clock() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  return {
    tasks,
    schedule(fn, ms) { const key = ++sequence; tasks.set(key, { fn, at: now + ms }); return () => tasks.delete(key); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        tasks.delete(next[0]); now = next[1].at; next[1].fn(); await flush();
      }
      now = target; await flush();
    },
  };
}
function harness(t, options = {}) {
  const timer = clock(), channels = [], history = [];
  let result = fixture(), loads = 0, starts = 0;
  const controller = createRoomSynchronization({
    load: async signal => { loads++; return options.load ? options.load(signal, loads) : result; },
    start: async (id, signal) => { starts++; return options.start ? options.start(id, signal) : started; },
    transport: { subscribe(topic, changed, status) {
      const channel = { topic, changed, status, removed: false }; channels.push(channel);
      return () => { channel.removed = true; };
    } },
    schedule: timer.schedule, changed: state => history.push(state), timeoutMs: 100,
  });
  t.after(() => controller.stop());
  return { controller, timer, channels, history, set: v => { result = v; }, loads: () => loads, starts: () => starts };
}

test("room versions stay decimal strings beyond JavaScript safe integers", () => {
  for (const value of ["0", "1", "9007199254740993", "9223372036854775807"]) assert.ok(isRoomVersion(value));
  for (const value of [1, "-1", "01", "", "1.0", "9223372036854775808", null]) assert.equal(isRoomVersion(value), false);
  assert.ok(compareRoomVersions("9007199254740993", "9007199254740992") > 0);
  assert.ok(compareRoomVersions("10", "9") > 0);
});

test("snapshot adapter uses one RPC and re-verifies identity without signup", async () => {
  const c = client(raw(fixture("9007199254740993")));
  const result = await getRoomSnapshot(c, roomId);
  assert.equal(result.version, "9007199254740993");
  assert.deepEqual(c.calls, [{ name: "get_robot_room_snapshot", args: { p_room_id: roomId } }]);
  assert.deepEqual(await getRoomSnapshot(client(raw(), [null]), roomId), { kind: "missing-session" });
  assert.deepEqual(await getRoomSnapshot(client(raw(), [userId, otherId]), roomId), { kind: "missing-session" });
});

test("snapshot handles domain rejection, missing data and forged membership safely", async () => {
  assert.deepEqual(await getRoomSnapshot(client({ error_code: "room_unavailable" }), roomId), { kind: "unavailable" });
  for (const value of [null, { ...raw(), members: [] }, { ...raw(), room_version: 1 },
    { ...raw(), participant_id: otherId }, { ...raw(), room: { ...fixture().room, id: otherId } },
    { ...raw(), members: [...fixture().members, ...fixture().members] }]) {
    await assert.rejects(getRoomSnapshot(client(value), roomId));
  }
  await assert.rejects(getRoomSnapshot(client({ error_code: "unknown_rejection" }), roomId), error => error.code === "unknown_rejection");
  await assert.rejects(getRoomSnapshot(client(raw()), "invalid"));
});

test("start adapter respects structured HTTP 200 errors and idempotent results", async () => {
  for (const already_started of [false, true]) {
    const c = client({ ...started, already_started });
    assert.equal((await startRoom(c, roomId, userId)).already_started, already_started);
    assert.deepEqual(c.calls, [{ name: "start_robot_room", args: { p_room_id: roomId } }]);
  }
  for (const code of ["not_organizer", "room_unavailable", "invalid_room_state"]) {
    await assert.rejects(startRoom(client({ ...started, error_code: code }), roomId, userId), error => error.code === code);
  }
  for (const data of [null, { ...started, status: "waiting" }, { ...started, room_version: 2 }, { ...started, started_at: null }]) {
    await assert.rejects(startRoom(client(data), roomId, userId));
  }
});

test("start adapter never dispatches under a different or missing identity", async () => {
  for (const id of [null, otherId]) {
    const c = client(started, [id]);
    await assert.rejects(startRoom(c, roomId, userId));
    assert.equal(c.calls.length, 0);
  }
  await assert.rejects(startRoom(client(started, [userId, otherId]), roomId, userId), /changed/);
});

test("initial snapshot precedes private membership binding and post-subscribe refresh", async t => {
  const h = harness(t); h.controller.run(); await flush();
  assert.equal(h.loads(), 1);
  assert.equal(h.channels.length, 1);
  assert.equal(h.channels[0].topic, membershipTopic(fixture()));
  h.channels[0].status("SUBSCRIBED"); await flush();
  assert.equal(h.loads(), 2);
  assert.equal(h.controller.getState().connection, "live");
});

test("duplicate events coalesce but changes arriving during refresh are not lost", async t => {
  const pending = deferred();
  const h = harness(t, { load: async (_, count) => count === 2 ? pending.promise : fixture(count === 1 ? "1" : "3") });
  h.controller.run(); await flush();
  h.channels[0].changed(); await flush();
  for (let i = 0; i < 20; i++) h.channels[0].changed();
  assert.equal(h.loads(), 2);
  pending.resolve(fixture("2")); await flush();
  assert.equal(h.loads(), 3);
  assert.equal(h.controller.getState().view.version, "3");
  assert.equal(h.channels.length, 1);
});

test("stale revisions cannot regress participants from Training Preparation", async t => {
  const h = harness(t); h.set(fixture("9007199254740993", "task_assignment", "participant"));
  h.controller.run(); await flush();
  h.set(fixture("9007199254740992", "waiting", "participant"));
  await h.controller.refresh();
  assert.equal(h.controller.getState().view.room.status, "task_assignment");
  assert.equal(h.controller.getState().view.version, "9007199254740993");
});

test("poll repairs missed notifications, skips hidden pages and recovers on visibility", async t => {
  const h = harness(t); h.controller.run(); await flush();
  h.set(fixture("2", "task_assignment"));
  await h.timer.advance(15000);
  assert.equal(h.controller.getState().view.room.status, "task_assignment");
  h.controller.setVisible(false); const before = h.loads();
  await h.timer.advance(30000); assert.equal(h.loads(), before);
  h.controller.setVisible(true); await flush(); assert.equal(h.loads(), before + 1);
});

test("reconnect and authorization errors recheck snapshots without duplicate leases", async t => {
  const h = harness(t); h.controller.run(); await flush();
  h.channels[0].status("CHANNEL_ERROR"); await flush();
  assert.equal(h.controller.getState().connection, "polling");
  assert.equal(h.channels.length, 1);
  h.set(fixture("2", "task_assignment")); h.channels[0].status("SUBSCRIBED"); await flush();
  assert.equal(h.controller.getState().connection, "live");
  assert.equal(h.controller.getState().view.room.status, "task_assignment");
});

test("organizer may start alone; duplicate starts await authoritative confirmation", async t => {
  const write = deferred();
  const h = harness(t, { start: async () => { await write.promise; h.set(fixture("2", "task_assignment")); return started; } });
  h.controller.run(); await flush();
  const first = h.controller.startTraining();
  await h.controller.startTraining(); assert.equal(h.starts(), 1);
  assert.equal(h.controller.getState().view.room.status, "waiting");
  assert.equal(h.controller.getState().startPending, true);
  write.resolve(); await first;
  assert.equal(h.controller.getState().view.room.status, "task_assignment");
  assert.equal(h.controller.getState().startPending, false);
});

test("participant and creator mismatch cannot invoke start through the controller", async t => {
  const h = harness(t); h.set(fixture("1", "waiting", "participant"));
  h.controller.run(); await flush(); await h.controller.startTraining();
  assert.equal(h.starts(), 0);
  assert.equal(canStartTraining({ ...fixture(), room: { ...fixture().room, created_by: otherId } }), false);
});

test("uncertain and idempotent starts reconcile by snapshot without another mutation", async t => {
  const h = harness(t, { start: async () => {
    h.set(fixture("2", "task_assignment"));
    throw new TypeError("Response lost after database commit");
  } });
  h.controller.run(); await flush(); await h.controller.startTraining();
  assert.equal(h.starts(), 1);
  assert.equal(h.controller.getState().view.room.status, "task_assignment");
  assert.equal(h.controller.getState().startPending, false);
});

test("organizer permission failure remains a rejection after snapshot refresh", async t => {
  const h = harness(t, { start: async () => { throw new RoomOperationError("Organizer only", "not_organizer"); } });
  h.controller.run(); await flush(); await h.controller.startTraining();
  assert.equal(h.controller.getState().view.room.status, "waiting");
  assert.equal(h.controller.getState().notice, "Organizer only");
});

test("timeout hides old data, releases loading state and permits same-session recovery", async t => {
  const blocked = deferred();
  const h = harness(t, { load: (_, count) => count === 1 ? blocked.promise : Promise.resolve(fixture()) });
  h.controller.run(); await flush();
  assert.equal(h.controller.getState().view.kind, "loading");
  await h.timer.advance(100);
  assert.equal(h.controller.getState().view.kind, "error");
  assert.equal(h.controller.getState().refreshing, false);
  await h.controller.refresh(); assert.equal(h.controller.getState().view.kind, "ready");
  blocked.resolve(fixture("99")); await flush();
  assert.equal(h.controller.getState().view.version, "1");
});

test("identity changes abort old requests and late replies never expose their snapshot", async t => {
  const blocked = deferred();
  const h = harness(t, { load: (_, count) => count === 1 ? blocked.promise : Promise.resolve({ kind: "missing-session" }) });
  h.controller.run(); await flush(); h.controller.identityChanged();
  await h.timer.advance(0); await flush();
  blocked.resolve(fixture()); await flush();
  assert.equal(h.controller.getState().view.kind, "missing-session");
  assert.equal(h.channels.length, 0);
});

test("failed verification releases the channel and recovery reauthorizes a new lease", async t => {
  let failed = false;
  const h = harness(t, { load: async () => {
    if (failed) throw new TypeError("Connection unavailable");
    return fixture();
  } });
  h.controller.run(); await flush();
  h.channels[0].status("SUBSCRIBED"); await flush();
  failed = true; await h.controller.refresh();
  assert.equal(h.controller.getState().view.kind, "error");
  assert.equal(h.channels[0].removed, true);
  failed = false; await h.controller.refresh();
  assert.equal(h.channels.length, 2);
  h.channels[1].status("SUBSCRIBED"); await flush();
  assert.equal(h.controller.getState().connection, "live");
  assert.equal(h.controller.getState().view.kind, "ready");
});

test("revocation and session loss clear authorized content and remove owned subscriptions", async t => {
  for (const kind of ["unavailable", "missing-session"]) {
    const h = harness(t); h.controller.run(); await flush();
    h.set({ kind }); await h.controller.refresh();
    assert.equal(h.controller.getState().view.kind, kind);
    assert.equal(h.channels[0].removed, true);
  }
});

test("unmount aborts pending work, timers and leases; stale callbacks are ignored", async t => {
  const h = harness(t); h.controller.run(); await flush();
  h.controller.stop(); const before = h.history.length;
  h.channels[0].changed(); h.channels[0].status("SUBSCRIBED");
  await h.timer.advance(30000);
  assert.equal(h.channels[0].removed, true);
  assert.equal(h.timer.tasks.size, 0);
  assert.equal(h.history.length, before);
});

function sdkFixture() {
  const channels = [], removed = [];
  let auth = 0;
  const c = {
    realtime: { setAuth: async () => { auth++; } }, getChannels: () => channels,
    channel(topic, config) {
      const ch = { topic: "realtime:" + topic, config, teardown() { ch.torn = true; },
        on(type, filter, fn) { assert.equal(type, "broadcast"); assert.equal(filter.event, "room_changed"); ch.message = fn; return ch; },
        subscribe(fn) { ch.status = fn; return ch; } };
      channels.push(ch); return ch;
    },
    async removeChannel(ch) { removed.push(ch); channels.splice(channels.indexOf(ch), 1); },
  };
  return { c, channels, removed, auth: () => auth };
}
test("SDK adapter uses private channels, discards payloads and reference-counts cleanup", async () => {
  const sdk = sdkFixture(), statuses = []; let events = 0;
  const transport = roomRealtimeTransport(sdk.c), topic = membershipTopic(fixture());
  const first = transport.subscribe(topic, () => events++, status => statuses.push(status));
  const second = transport.subscribe(topic, () => events++, () => {});
  await flush();
  assert.equal(sdk.channels.length, 1);
  assert.equal(sdk.channels[0].config.config.private, true);
  assert.equal(sdk.channels[0].config.config.presence.enabled, false);
  sdk.channels[0].status("SUBSCRIBED");
  sdk.channels[0].message({ room: "forged-private-content", room_version: "999" });
  assert.equal(events, 2); assert.deepEqual(statuses, ["SUBSCRIBED"]);
  first(); assert.equal(sdk.removed.length, 0);
  second(); await flush(); assert.equal(sdk.removed.length, 1); assert.ok(sdk.removed[0].torn);
});

test("SDK adapter waits for pending teardown and never takes over an unowned channel", async () => {
  const sdk = sdkFixture(), gate = deferred();
  const original = sdk.c.removeChannel;
  sdk.c.removeChannel = async channel => { await gate.promise; return original(channel); };
  const t = roomRealtimeTransport(sdk.c), topic = membershipTopic(fixture());
  const first = t.subscribe(topic, () => {}, () => {}); await flush(); first();
  const second = t.subscribe(topic, () => {}, () => {}); await flush();
  assert.equal(sdk.channels.length, 1);
  gate.resolve(); await flush(); assert.equal(sdk.channels.length, 1);
  second(); await flush();
  sdk.channels.push({ topic: "realtime:" + topic, config: { private: false } });
  const statuses = [];
  const third = t.subscribe(topic, () => {}, status => statuses.push(status)); await flush();
  assert.deepEqual(statuses, ["CHANNEL_ERROR"]); third();
  assert.equal(sdk.channels.length, 1);
});

test("membership replacement rebinds once and rejects stale old membership snapshots", async t => {
  const h = harness(t); h.controller.run(); await flush();
  const next = fixture("3");
  next.participant = { ...next.participant, id: otherId };
  next.members = [next.participant];
  h.set(next); await h.controller.refresh();
  assert.equal(h.channels[0].removed, true);
  assert.equal(h.channels[1].topic, membershipTopic(next));
  h.set(fixture("2")); await h.controller.refresh();
  assert.equal(h.controller.getState().view.participant.id, otherId);
  assert.equal(h.channels.length, 2);
});

test("start timeout reconciles once; a late result never optimistically changes phase", async t => {
  const pending = deferred();
  const h = harness(t, { start: () => pending.promise });
  h.controller.run(); await flush();
  const starting = h.controller.startTraining();
  await h.timer.advance(100); await starting;
  assert.equal(h.starts(), 1);
  assert.equal(h.controller.getState().view.room.status, "waiting");
  assert.equal(h.controller.getState().startPending, false);
  assert.match(h.controller.getState().notice, /couldn't confirm/);
  pending.resolve(started); await flush();
  assert.equal(h.controller.getState().view.room.status, "waiting");
  h.set(fixture("2", "task_assignment")); await h.timer.advance(15000);
  assert.equal(h.controller.getState().view.room.status, "task_assignment");
});

test("background notifications and reconnect errors wait until visible recovery", async t => {
  const h = harness(t); h.controller.run(); await flush();
  h.controller.setVisible(false);
  h.channels[0].changed(); h.channels[0].status("CHANNEL_ERROR"); h.controller.recover();
  await flush(); assert.equal(h.loads(), 1);
  h.set(fixture("2", "task_assignment"));
  h.controller.setVisible(true); await flush();
  assert.equal(h.controller.getState().view.room.status, "task_assignment");
});
