import assert from "node:assert/strict";
import { test } from "node:test";
import { createWithRecovery, getCreationMarker, acknowledgeCreatedRoom } from "../src/features/rooms/creation-recovery.ts";
import { RoomOperationError, createRoom, getCreatedRooms } from "../src/features/rooms/data-access.ts";
import { loadLobby, invitationUrl } from "../src/features/rooms/lobby-data.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const roomId = "00000000-0000-4000-8000-000000000010";
const participantId = "00000000-0000-4000-8000-000000000020";
const membership = { room: { id: roomId }, participant: { id: participantId } };
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test("in-flight creation marker blocks another dispatch and retains confirmed recovery IDs", async () => {
  const store = storage(); let complete; let dispatched = 0;
  const first = createWithRecovery(store, userId, () => { dispatched++; return new Promise(resolve => { complete = resolve; }); });
  await assert.rejects(createWithRecovery(store, userId, async () => { dispatched++; return membership; }), /previous room/);
  complete(membership);
  assert.equal(await first, membership);
  assert.equal(dispatched, 1);
  assert.equal(getCreationMarker(store, userId).roomId, roomId);
  acknowledgeCreatedRoom(store, userId);
  assert.equal(getCreationMarker(store, userId), null);
});

test("uncertain creation survives reload and never automatically retries", async () => {
  const store = storage(); let calls = 0;
  await assert.rejects(createWithRecovery(store, userId, async () => { calls++; throw new TypeError("Network failed"); }));
  assert.ok(getCreationMarker(store, userId));
  await assert.rejects(createWithRecovery(store, userId, async () => { calls++; return membership; }), /previous room/);
  assert.equal(calls, 1);
});

test("timeout preserves uncertainty while a late success remains recoverable", async () => {
  const store = storage(); let complete;
  await assert.rejects(createWithRecovery(store, userId, () => new Promise(resolve => { complete = resolve; }), 5), /result has not arrived/);
  assert.ok(getCreationMarker(store, userId));
  complete(membership);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getCreationMarker(store, userId).roomId, roomId);
});

test("known server domain rejection permits an intentional retry without retaining uncertainty", async () => {
  const store = storage();
  await assert.rejects(createWithRecovery(store, userId, async () => { throw new RoomOperationError("Rejected", "room_quota_exceeded"); }));
  assert.equal(getCreationMarker(store, userId), null);
});

test("unavailable or damaged browser storage cannot permit an unrecorded creation", async () => {
  let calls = 0;
  const blocked = { getItem: () => null, setItem: () => { throw new Error("Storage denied"); }, removeItem: () => {} };
  await assert.rejects(createWithRecovery(blocked, userId, async () => { calls++; return membership; }));
  const damaged = storage(); damaged.setItem(`what-is-love:pending-room:${userId}`, "not-json");
  await assert.rejects(createWithRecovery(damaged, userId, async () => { calls++; return membership; }));
  assert.equal(calls, 0);
});

test("committed creation whose read fails carries its confirmed room ID and never resends the RPC", async () => {
  let calls = 0;
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
    rpc: () => { calls++; return { single: async () => ({ data: { room_id: roomId, participant_id: participantId, error_code: null }, error: null }) }; },
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: { code: "503" } }) }),
  };
  const store = storage();
  await assert.rejects(createWithRecovery(store, userId, () => createRoom(client, { nickname: "River" })), error => error.confirmedRoomId === roomId);
  assert.equal(calls, 1);
  assert.equal(getCreationMarker(store, userId).roomId, roomId);
});

test("created-room recovery filters by verified identity and preserves the RLS boundary", async () => {
  const calls = [];
  const builder = { select(...args) { calls.push(["select", ...args]); return this; }, eq(...args) { calls.push(["eq", ...args]); return this; }, order() { return this; }, limit: async () => ({ data: [], error: null }) };
  const client = { auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, from: table => { calls.push(["from", table]); return builder; } };
  assert.deepEqual(await getCreatedRooms(client), []);
  assert.deepEqual(calls, [["from", "rooms"], ["select", "*"], ["eq", "created_by", userId]]);
});

function lobbyClient({ user = { id: userId }, room = { id: roomId }, members = [{ id: participantId, auth_user_id: userId }], changedIdentity = false } = {}) {
  let verifications = 0;
  return {
    auth: { getUser: async () => ({ data: { user: changedIdentity && ++verifications === 4 ? { id: "another-user" } : user }, error: null }) },
    from: table => {
      const builder = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: room, error: null }),
        order() { return this; }, then(resolve) { resolve({ data: table === "room_participants" ? members : [], error: null }); } };
      return builder;
    },
  };
}

test("lobby opening never signs up or joins when the original session is missing", async () => {
  const client = lobbyClient({ user: null });
  client.from = () => assert.fail("Missing identity cannot read rooms");
  assert.deepEqual(await loadLobby(client, roomId), { kind: "missing-session" });
});

test("unauthorized lobby reveals no room or participant metadata", async () => {
  assert.deepEqual(await loadLobby(lobbyClient({ room: null }), roomId), { kind: "unavailable" });
  assert.deepEqual(await loadLobby(lobbyClient({ members: [] }), roomId), { kind: "unavailable" });
});

test("authorized lobby uses the restored member identity and discards results after identity replacement", async () => {
  const result = await loadLobby(lobbyClient(), roomId);
  assert.equal(result.kind, "ready");
  assert.equal(result.participant.id, participantId);
  assert.deepEqual(await loadLobby(lobbyClient({ changedIdentity: true }), roomId), { kind: "missing-session" });
});

test("invitation links use the application origin and direct join route", () => {
  assert.equal(invitationUrl("https://example.com", "ABCDEFGHJKLM"), "https://example.com/join?code=ABCDEFGHJKLM");
});
