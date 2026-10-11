import assert from "node:assert/strict";
import test from "node:test";
import { createAnonymousSignInCoordinator } from "../src/features/auth/anonymous-session-coordination.ts";
import { ensureAnonymousParticipant } from "../src/features/auth/participant-session.ts";

// Models independent tabs sharing origin locks/storage; real browser coverage runs separately.
function browserOrigin() {
  const values = new Map();
  let queue = Promise.resolve();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const locks = { request: (_key, options, operation) => {
    assert.equal(options.mode, "exclusive");
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  } };
  return { storage, locks, values };
}
const absent = { data: { user: null }, error: { name: "AuthSessionMissingError" } };
const user = { id: "local-browser-user", is_anonymous: true };

test("independent tabs recheck shared sessions inside the origin lock and create one identity", async () => {
  const origin = browserOrigin();
  let currentUser = null;
  let signups = 0;
  const client = () => ({ auth: {
    getUser: async () => currentUser ? { data: { user: currentUser }, error: null } : absent,
    signInAnonymously: async () => {
      signups++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      currentUser = user;
      return { data: { user, session: { user } }, error: null };
    },
  } });
  const identities = await Promise.all(Array.from({ length: 8 }, () =>
    ensureAnonymousParticipant(client(), { coordinate: createAnonymousSignInCoordinator(origin) })));
  assert.equal(signups, 1);
  for (const identity of identities) assert.equal(identity.userId, user.id);
  assert.deepEqual([...origin.values.values()], ["complete"]);
  assert.equal((await ensureAnonymousParticipant(client())).userId, user.id);
});

test("failed or interrupted initial signup blocks silent replacement across tabs until explicit retry", async () => {
  const origin = browserOrigin();
  const coordinate = createAnonymousSignInCoordinator(origin);
  let attempts = 0;
  let succeed = false;
  const client = () => ({ auth: {
    getUser: async () => absent,
    signInAnonymously: async () => {
      attempts++;
      return succeed ? { data: { user, session: { user } }, error: null }
        : { data: { user: null, session: null }, error: { name: "AuthApiError" } };
    },
  } });
  await assert.rejects(ensureAnonymousParticipant(client(), { coordinate }), /Anonymous sign-in failed/);
  assert.deepEqual([...origin.values.values()], ["pending"]);
  await assert.rejects(ensureAnonymousParticipant(client(), { coordinate }), /explicitly retry/);
  assert.equal(attempts, 1);
  succeed = true;
  await ensureAnonymousParticipant(client(), { coordinate, retryInterruptedSignIn: true });
  assert.equal(attempts, 2);
  assert.deepEqual([...origin.values.values()], ["complete"]);
});

test("verified cookie recovery completes an interrupted attempt without creating another account", async () => {
  const origin = browserOrigin();
  let reads = 0;
  await createAnonymousSignInCoordinator(origin)(async (state) => state.markAttempt());
  const result = await ensureAnonymousParticipant({ auth: {
    getUser: async () => ++reads === 1 ? absent : { data: { user }, error: null },
    signInAnonymously: () => assert.fail("Recovered cookies must be reused"),
  } }, { coordinate: createAnonymousSignInCoordinator(origin) });
  assert.equal(result.userId, user.id);
  assert.deepEqual([...origin.values.values()], ["complete"]);
});

test("unavailable coordination or storage fails closed for signup but preserves existing sessions", async () => {
  const client = { auth: {
    getUser: async () => absent,
    signInAnonymously: () => assert.fail("No uncoordinated signup"),
  } };
  await assert.rejects(ensureAnonymousParticipant(client), /cannot safely coordinate/);
  const origin = browserOrigin();
  origin.storage.getItem = () => { throw new Error("storage disabled"); };
  await assert.rejects(ensureAnonymousParticipant(client, { coordinate: createAnonymousSignInCoordinator(origin) }), /Browser storage/);
});

test("verification errors inside the lock never trigger signup", async () => {
  let reads = 0;
  await assert.rejects(ensureAnonymousParticipant({ auth: {
    getUser: async () => ++reads === 1 ? absent : { data: { user: null }, error: { name: "AuthApiError" } },
    signInAnonymously: () => assert.fail("Failed verification cannot replace an identity"),
  } }, { coordinate: createAnonymousSignInCoordinator(browserOrigin()) }), /Unable to verify/);
});

test("completed signup waits for delayed cookie visibility without creating another identity", async () => {
  const origin = browserOrigin();
  const coordinate = createAnonymousSignInCoordinator(origin);
  await coordinate(async (state) => state.complete());
  let reads = 0;
  const result = await ensureAnonymousParticipant({ auth: {
    getUser: async () => ++reads < 4 ? absent : { data: { user }, error: null },
    signInAnonymously: () => assert.fail("Delayed cookie visibility is not permission for another signup"),
  } }, { coordinate });
  assert.equal(result.userId, user.id);
});

test("lost cookies after a completed signup fail closed until explicit replacement retry", async () => {
  const coordinate = createAnonymousSignInCoordinator(browserOrigin());
  await coordinate(async (state) => state.complete());
  await assert.rejects(ensureAnonymousParticipant({ auth: {
    getUser: async () => absent,
    signInAnonymously: () => assert.fail("Lost cookies must not silently replace the identity"),
  } }, { coordinate }), /previous participant session is unavailable.*explicitly retry/);
});
