import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../lib/supabase/database.types.ts";
import { restoreParticipantSession } from "../auth/participant-session.ts";
import { getAuthorizedRoom, getRoomMembers } from "./data-access.ts";

/** Read-only recovery: opening a lobby never creates a user or membership. */
export async function loadLobby(client: SupabaseClient<Database>, roomId: string) {
  const identity = await restoreParticipantSession(client);
  if (!identity) return { kind: "missing-session" as const };
  const room = await getAuthorizedRoom(client, roomId);
  if (!room) return { kind: "unavailable" as const };
  const members = await getRoomMembers(client, roomId);
  const participant = members.find((member) => member.auth_user_id === identity.userId);
  if (!participant) return { kind: "unavailable" as const };
  const current = await restoreParticipantSession(client);
  if (current?.userId !== identity.userId) return { kind: "missing-session" as const };
  return { kind: "ready" as const, identity, room, participant, members };
}

export function invitationUrl(origin: string, code: string): string {
  return new URL(`/join?code=${encodeURIComponent(code)}`, origin).href;
}
