import assert from "node:assert/strict";
import test from "node:test";
import { ROOM_STATUSES } from "../src/features/rooms/types.ts";
import { isRoomStatus, normalizeJoinCode, validateNickname } from "../src/features/rooms/validation.ts";
import { createRoom, joinRoom, getAuthorizedRoom, getRoomMembers } from "../src/features/rooms/data-access.ts";

test("only the nine reviewed room statuses are accepted", () => {
  assert.equal(ROOM_STATUSES.length, 9);
  for (const status of ROOM_STATUSES) assert.equal(isRoomStatus(status), true);
  for (const status of ["started", "WAITING", "", null, undefined, 0, {}]) assert.equal(isRoomStatus(status), false);
});

test("invitation codes are normalized and ambiguous or malformed codes rejected", () => {
  assert.equal(normalizeJoinCode(" abcd-efgh-jklm "), "ABCDEFGHJKLM");
  for (const code of ["ABC", "ABCDEFGHIJKL", "ABCDEFGHJKLO", "ABCDEFGHJKL0", "ABCDEFGHJKL1", "ABCD EFGHJKLM", "a".repeat(33), null]) {
    assert.throws(() => normalizeJoinCode(code), /valid 12-character/);
  }
});

test("nickname validation matches database character counts and rejects controls", () => {
  assert.equal(validateNickname("  River  "), "River");
  assert.equal(validateNickname("💛".repeat(40)), "💛".repeat(40));
  for (const name of ["", "  ", "x".repeat(41), "💛".repeat(41), "A\nB", "A\0B", "A\x7fB", undefined]) {
    assert.throws(() => validateNickname(name), /nickname/);
  }
});

const userId = "00000000-0000-4000-8000-000000000001";
const missingSession = { data: { user: null }, error: { name: "AuthSessionMissingError" } };

test("room operations require verified identity and never silently sign up", async () => {
  const client = {
    auth: {
      getUser: async () => missingSession,
      signInAnonymously: () => assert.fail("Room access must not create an identity"),
    },
    rpc: () => assert.fail("Unauthenticated RPC"),
    from: () => assert.fail("Unauthenticated read"),
  };
  await assert.rejects(createRoom(client, { nickname: "River" }), /authenticated participant/);
  await assert.rejects(joinRoom(client, { joinCode: "ABCDEFGHJKLM", nickname: "River" }), /authenticated participant/);
  await assert.rejects(getAuthorizedRoom(client, userId), /authenticated participant/);
  await assert.rejects(getRoomMembers(client, userId), /authenticated participant/);
});

test("invalid input fails before an Auth or database request", async () => {
  const client = { auth: { getUser: () => assert.fail("Invalid input must not make a request") } };
  await assert.rejects(createRoom(client, { nickname: "" }), /nickname/);
  await assert.rejects(joinRoom(client, { joinCode: "wrong", nickname: "River" }), /room code/);
  await assert.rejects(getAuthorizedRoom(client, "invalid-id"), /valid room ID/);
  await assert.rejects(getRoomMembers(client, "invalid-id"), /valid room ID/);
});

test("writes use only reviewed RPC arguments, discard supplied roles/IDs, and propagate failure", async () => {
  const calls = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: userId, is_anonymous: true } }, error: null }) },
    rpc: (name, args) => {
      calls.push({ name, args });
      return { single: async () => ({ data: null, error: { code: "42501", message: "internal-private-details" } }) };
    },
    from: () => assert.fail("RPC failures must not be converted to fake success"),
  };
  await assert.rejects(createRoom(client, { nickname: " River ", created_by: "forged", role: "organizer", joinCode: "forged" }), (error) => {
    assert.equal(error.code, "42501");
    assert.ok(!error.message.includes("internal-private-details"));
    return true;
  });
  await assert.rejects(joinRoom(client, { nickname: " River ", joinCode: "abcd-efgh-jklm", auth_user_id: "forged", role: "organizer" }), /Unable to join/);
  assert.deepEqual(calls, [
    { name: "create_robot_room", args: { p_nickname: "River" } },
    { name: "join_robot_room", args: { p_nickname: "River", p_join_code: "ABCDEFGHJKLM" } },
  ]);
});

test("structured rate and quota rejections never become fake memberships", async () => {
  for (const code of ["rate_limited", "room_quota_exceeded", "membership_quota_exceeded", "room_unavailable", "code_allocation_failed"]) {
    const client = {
      auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) },
      rpc: () => ({ single: async () => ({ data: { room_id: null, participant_id: null, error_code: code }, error: null }) }),
      from: () => assert.fail("Rejected request must not load records"),
    };
    await assert.rejects(createRoom(client, { nickname: "River" }), (error) => error.code === code);
    await assert.rejects(joinRoom(client, { nickname: "River", joinCode: "ABCDEFGHJKLM" }), (error) => error.code === code);
  }
});
