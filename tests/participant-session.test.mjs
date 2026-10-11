import assert from "node:assert/strict";
import test from "node:test";
import { ensureAnonymousParticipant, restoreParticipantSession, requireParticipant } from "../src/features/auth/participant-session.ts";

// Auth API contract fixtures only; these are never imported by the application.
const fixtureUser = { id: "00000000-0000-4000-8000-000000000001", is_anonymous: true };
const coordinate = async (operation) => operation({ interrupted: false, markAttempt() {}, complete() {} });
const noSession = { data: { user: null }, error: { name: "AuthSessionMissingError" } };

test("session restoration verifies the user without trusting getSession", async () => {
  const client = { auth: {
    getUser: async () => ({ data: { user: fixtureUser }, error: null }),
    getSession: () => assert.fail("Do not authorize using unverified session contents"),
  } };
  assert.deepEqual(await restoreParticipantSession(client), { userId: fixtureUser.id, isAnonymous: true });
});

test("an existing identity is reused on refresh instead of signing up again", async () => {
  const client = { auth: {
    getUser: async () => ({ data: { user: fixtureUser }, error: null }),
    signInAnonymously: () => assert.fail("Existing identity must be preserved"),
  } };
  assert.deepEqual(await ensureAnonymousParticipant(client), await restoreParticipantSession(client));
});

test("missing sessions are distinct from invalid sessions and Auth outages", async () => {
  assert.equal(await restoreParticipantSession({ auth: { getUser: async () => noSession } }), null);
  for (const error of [{ name: "AuthApiError", status: 401 }, { name: "AuthRetryableFetchError" }]) {
    const client = { auth: {
      getUser: async () => ({ data: { user: null }, error }),
      signInAnonymously: () => assert.fail("Verification failure must not discard the existing identity"),
    } };
    await assert.rejects(ensureAnonymousParticipant(client), /Unable to verify/);
  }
});

test("concurrent calls on one client produce one anonymous sign-in and support CAPTCHA", async () => {
  let signIns = 0;
  const client = { auth: {
    getUser: async () => noSession,
    signInAnonymously: async (credentials) => {
      signIns++;
      assert.deepEqual(credentials, { options: { captchaToken: "local-test-captcha-token" } });
      return { data: { user: fixtureUser, session: { user: fixtureUser } }, error: null };
    },
  } };
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureAnonymousParticipant(client, { captchaToken: "local-test-captcha-token", coordinate })));
  assert.equal(signIns, 1);
  for (const result of results) assert.deepEqual(result, { userId: fixtureUser.id, isAnonymous: true });
});

test("failed sign-in is reported without mock success and may be retried", async () => {
  let attempts = 0;
  const client = { auth: {
    getUser: async () => noSession,
    signInAnonymously: async () => { attempts++; return { data: { user: null, session: null }, error: { name: "AuthApiError" } }; },
  } };
  await assert.rejects(ensureAnonymousParticipant(client, { coordinate }), /Anonymous sign-in failed/);
  await assert.rejects(ensureAnonymousParticipant(client, { coordinate }), /Anonymous sign-in failed/);
  assert.equal(attempts, 2);
});

test("a protected operation cannot use a display name as identity", async () => {
  await assert.rejects(requireParticipant({ auth: { getUser: async () => noSession } }), /authenticated participant/);
});
