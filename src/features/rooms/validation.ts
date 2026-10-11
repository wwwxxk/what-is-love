import { ROOM_STATUSES, type RoomStatus } from "./types.ts";

export const JOIN_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/;

export function isRoomStatus(value: unknown): value is RoomStatus {
  return typeof value === "string" && ROOM_STATUSES.some((status) => status === value);
}

export function normalizeJoinCode(value: string): string {
  if (typeof value !== "string" || value.length > 32) throw new Error("Enter a valid 12-character room code.");
  const code = value.trim().toUpperCase().replaceAll("-", "");
  if (!JOIN_CODE_PATTERN.test(code)) throw new Error("Enter a valid 12-character room code.");
  return code;
}

export function validateNickname(value: string): string {
  if (typeof value !== "string") throw new Error("Enter a nickname of 1 to 40 characters.");
  const nickname = value.trim();
  // Unicode code points match PostgreSQL char_length (emoji count as one character).
  if ([...nickname].length < 1 || [...nickname].length > 40 || /[\u0000-\u001f\u007f]/.test(nickname)) {
    throw new Error("Enter a nickname of 1 to 40 characters without control characters.");
  }
  return nickname;
}
