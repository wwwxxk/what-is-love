import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Room, RoomParticipant, RoomRpcResult } from "../../lib/supabase/database.types.ts";
import { requireParticipant } from "../auth/participant-session.ts";
import type { CreateRoomInput, JoinRoomInput } from "./types.ts";
import { normalizeJoinCode, validateNickname } from "./validation.ts";

export type RoomMembership = Readonly<{ room: Room; participant: RoomParticipant }>;
type RoomClient = SupabaseClient<Database>;

export class RoomOperationError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "RoomOperationError";
    this.code = code;
  }
}

function validateRoomId(id: string): void {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) {
    throw new RoomOperationError("A valid room ID is required.");
  }
}

/** Missing and unauthorized rooms both return null; RLS is the access boundary. */
export async function getAuthorizedRoom(client: RoomClient, roomId: string): Promise<Room | null> {
  validateRoomId(roomId);
  await requireParticipant(client);
  const { data, error } = await client.from("rooms").select("*").eq("id", roomId).maybeSingle();
  if (error) throw new RoomOperationError("Unable to retrieve the room.", error.code);
  return data;
}

export async function getRoomMembers(client: RoomClient, roomId: string): Promise<RoomParticipant[]> {
  validateRoomId(roomId);
  await requireParticipant(client);
  const { data, error } = await client.from("room_participants").select("*")
    .eq("room_id", roomId).order("joined_at").order("id");
  if (error) throw new RoomOperationError("Unable to retrieve room members.", error.code);
  return data;
}

async function loadMembership(client: RoomClient, result: { room_id: string; participant_id: string }): Promise<RoomMembership> {
  const room = await getAuthorizedRoom(client, result.room_id);
  const { data: participant, error } = await client.from("room_participants").select("*")
    .eq("id", result.participant_id).eq("room_id", result.room_id).single();
  if (!room || error || !participant) throw new RoomOperationError("Unable to retrieve the authorized membership.", error?.code);
  return { room, participant };
}

function requireSuccessfulRpc(result: RoomRpcResult): { room_id: string; participant_id: string } {
  if (result.error_code) {
    const messages: Record<string, string> = {
      rate_limited: "Too many room requests. Wait before trying again.",
      room_quota_exceeded: "Your retained room limit has been reached.",
      membership_quota_exceeded: "Your room membership limit has been reached.",
      invalid_nickname: "Enter a nickname of 1 to 40 characters without control characters.",
      room_unavailable: "Unable to join this room. Check the invitation and whether the room accepts participants.",
      code_allocation_failed: "Unable to allocate a room invitation. Try again later.",
    };
    throw new RoomOperationError(messages[result.error_code] ?? "The room request was rejected.", result.error_code);
  }
  if (!result.room_id || !result.participant_id) throw new RoomOperationError("The room request returned an invalid result.");
  return { room_id: result.room_id, participant_id: result.participant_id };
}

export async function createRoom(client: RoomClient, input: CreateRoomInput): Promise<RoomMembership> {
  const nickname = validateNickname(input.nickname);
  await requireParticipant(client);
  const { data, error } = await client.rpc("create_robot_room", { p_nickname: nickname }).single();
  if (error || !data) throw new RoomOperationError("Unable to create the room. Confirm the reviewed migrations are applied, then retry.", error?.code);
  return loadMembership(client, requireSuccessfulRpc(data));
}

export async function joinRoom(client: RoomClient, input: JoinRoomInput): Promise<RoomMembership> {
  const joinCode = normalizeJoinCode(input.joinCode);
  const nickname = validateNickname(input.nickname);
  await requireParticipant(client);
  const { data, error } = await client.rpc("join_robot_room", { p_join_code: joinCode, p_nickname: nickname }).single();
  if (error || !data) throw new RoomOperationError("Unable to join this room. Check the invitation and whether the room accepts new participants.", error?.code);
  return loadMembership(client, requireSuccessfulRpc(data));
}
