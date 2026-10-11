import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "../../lib/supabase/database.types.ts";
import { createAnonymousSignInCoordinator, type AnonymousSignInCoordinator } from "./anonymous-session-coordination.ts";

export type ParticipantIdentity = Readonly<{ userId: string; isAnonymous: boolean }>;

export class ParticipantAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParticipantAuthError";
  }
}

function identity(user: User): ParticipantIdentity {
  return { userId: user.id, isAnonymous: user.is_anonymous === true };
}

/** Auth verifies the user; unverified getSession() data is never used for authorization. */
export async function restoreParticipantSession(client: SupabaseClient<Database>): Promise<ParticipantIdentity | null> {
  const { data, error } = await client.auth.getUser();
  if (error) {
    if (error.name === "AuthSessionMissingError") return null;
    throw new ParticipantAuthError("Unable to verify the participant session. Retry before creating a new identity.");
  }
  return data.user ? identity(data.user) : null;
}

const pendingSignIns = new WeakMap<SupabaseClient<Database>, Promise<ParticipantIdentity>>();

/** Call on an explicit future create/join action, never on homepage render. */
export function ensureAnonymousParticipant(client: SupabaseClient<Database>, options?: {
  captchaToken?: string;
  /** Only after an explicit user retry of an interrupted/failed initial signup. */
  retryInterruptedSignIn?: boolean;
  /** Injectable browser primitive adapter for tests; production uses Web Locks. */
  coordinate?: AnonymousSignInCoordinator;
}): Promise<ParticipantIdentity> {
  const pending = pendingSignIns.get(client);
  if (pending) return pending;

  const operation = (async () => {
    const existing = await restoreParticipantSession(client);
    if (existing) return existing;
    const coordinate = options?.coordinate ?? createAnonymousSignInCoordinator();
    return coordinate(async (state) => {
      // Cookies may have changed while waiting for the other tab's lock.
      let restored = await restoreParticipantSession(client);
      // Cross-process cookie invalidation can arrive after the signup tab released its lock.
      // The transactional completion marker prevents a second signup during that gap.
      if (!restored && state.completed) {
        const deadline = Date.now() + 3000;
        while (!restored && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          restored = await restoreParticipantSession(client);
        }
      }
      if (restored) { await state.complete(); return restored; }
      if (state.interrupted && !options?.retryInterruptedSignIn) {
        throw new ParticipantAuthError(state.completed
          ? "The previous participant session is unavailable. Check the other tab, then explicitly retry; a replacement identity was not created."
          : "An earlier sign-in did not finish. Check the other tab, then explicitly retry; a replacement identity was not created.");
      }
      await state.markAttempt();
      const { data, error } = await client.auth.signInAnonymously({ options: { captchaToken: options?.captchaToken } });
      if (error || !data.user || !data.session) {
        throw new ParticipantAuthError("Anonymous sign-in failed. Check Supabase configuration, anonymous authentication, and abuse protection settings.");
      }
      await state.complete();
      return identity(data.user);
    });
  })();
  pendingSignIns.set(client, operation);
  void operation.finally(() => pendingSignIns.delete(client)).catch(() => {});
  return operation;
}

export async function requireParticipant(client: SupabaseClient<Database>): Promise<ParticipantIdentity> {
  const participant = await restoreParticipantSession(client);
  if (!participant) throw new ParticipantAuthError("An authenticated participant session is required. Sign in anonymously first.");
  return participant;
}
