import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Room, RoomParticipant, StartRoomResult } from "../../lib/supabase/database.types.ts";
import { ParticipantAuthError, restoreParticipantSession, type ParticipantIdentity } from "../auth/participant-session.ts";
import { RoomOperationError } from "./data-access.ts";
import { isRoomStatus, JOIN_CODE_PATTERN } from "./validation.ts";

export type RoomSnapshot = {
  kind: "ready"; identity: ParticipantIdentity;
  room: Room & { room_version: string }; participant: RoomParticipant;
  members: RoomParticipant[]; version: string;
};
export type SnapshotResult = RoomSnapshot | { kind: "missing-session" | "unavailable" };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
export function isRoomVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= BigInt("9223372036854775807");
}
export function compareRoomVersions(left: string, right: string): number {
  if (!isRoomVersion(left) || !isRoomVersion(right)) throw new RoomOperationError("Invalid room revision.");
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}
function roomId(value: string) {
  if (!UUID.test(value)) throw new RoomOperationError("A valid room ID is required.");
  return value.toLowerCase();
}
function validMember(value: unknown, id: string): value is RoomParticipant {
  return record(value) && typeof value.id === "string" && UUID.test(value.id)
    && value.room_id === id && typeof value.auth_user_id === "string" && UUID.test(value.auth_user_id)
    && typeof value.nickname === "string" && value.nickname.length > 0
    && (value.role === "organizer" || value.role === "participant")
    && timestamp(value.joined_at) && timestamp(value.updated_at);
}
function validRoom(value: unknown, id: string): value is Room & { room_version: string } {
  return record(value) && value.id === id && typeof value.join_code === "string"
    && JOIN_CODE_PATTERN.test(value.join_code) && isRoomStatus(value.status)
    && typeof value.created_by === "string" && UUID.test(value.created_by)
    && timestamp(value.created_at) && timestamp(value.updated_at)
    && (value.started_at === null || timestamp(value.started_at)) && isRoomVersion(value.room_version);
}
function rejectDomain(code: string) {
  const messages: Record<string, string> = {
    not_organizer: "Only this room's organizer can start training.",
    room_unavailable: "This room is no longer available to your saved identity.",
    invalid_room_state: "The room could not be started. Ask the organizer to check its state.",
  };
  throw new RoomOperationError(messages[code] ?? "The room request was rejected.", code);
}

/** One authorized SQL snapshot, bracketed by verified identity; never signs up. */
export async function getRoomSnapshot(client: SupabaseClient<Database>, id: string, signal?: AbortSignal): Promise<SnapshotResult> {
  id = roomId(id);
  const identity = await restoreParticipantSession(client);
  if (!identity) return { kind: "missing-session" };
  signal?.throwIfAborted();
  let request = client.rpc("get_robot_room_snapshot", { p_room_id: id });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request.single();
  if (error || !data) throw new RoomOperationError("We couldn't check this room. Try again when your connection returns.", error?.code);
  const current = await restoreParticipantSession(client);
  signal?.throwIfAborted();
  if (current?.userId !== identity.userId) return { kind: "missing-session" };
  if (data.error_code === "room_unavailable") return { kind: "unavailable" };
  if (data.error_code) rejectDomain(data.error_code);
  if (!validRoom(data.room, id) || !isRoomVersion(data.room_version)
    || data.room.room_version !== data.room_version || !Array.isArray(data.members)
    || !data.members.every((member) => validMember(member, id))) {
    throw new RoomOperationError("The room returned incomplete details. Try checking it again.");
  }
  const participant = data.members.find((member) =>
    member.id === data.participant_id && member.auth_user_id === identity.userId);
  if (!participant || new Set(data.members.map((member) => member.id)).size !== data.members.length) {
    throw new RoomOperationError("The room returned an invalid membership.");
  }
  return { kind: "ready", identity, room: data.room, participant, members: data.members, version: data.room_version };
}

/** The database enforces creator AND organizer membership and atomic idempotence. */
export async function startRoom(client: SupabaseClient<Database>, id: string, expectedUserId: string, signal?: AbortSignal): Promise<StartRoomResult> {
  id = roomId(id);
  const identity = await restoreParticipantSession(client);
  if (!identity || identity.userId !== expectedUserId) throw new ParticipantAuthError("Your saved identity changed. Return to your room before starting.");
  signal?.throwIfAborted();
  let request = client.rpc("start_robot_room", { p_room_id: id });
  if (signal) request = request.abortSignal(signal);
  const { data, error } = await request.single();
  if (error || !data) throw new RoomOperationError("We couldn't confirm the start request. Checking the room again.", error?.code);
  const current = await restoreParticipantSession(client);
  signal?.throwIfAborted();
  if (current?.userId !== identity.userId) throw new ParticipantAuthError("Your saved identity changed during the request.");
  if (data.error_code) rejectDomain(data.error_code);
  if (data.room_id !== id || !isRoomStatus(data.status) || data.status === "waiting"
    || !timestamp(data.started_at) || !isRoomVersion(data.room_version)
    || typeof data.already_started !== "boolean") {
    throw new RoomOperationError("The start request returned incomplete details. Checking the room again.");
  }
  return data;
}
