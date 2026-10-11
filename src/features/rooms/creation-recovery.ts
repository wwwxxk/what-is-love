import { RoomOperationError, type RoomMembership } from "./data-access.ts";

type MarkerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type CreationMarker = { attemptId: string; startedAt: string; roomId?: string };
const key = (userId: string) => `what-is-love:pending-room:${userId}`;
const knownRejections = new Set(["rate_limited", "room_quota_exceeded", "membership_quota_exceeded", "invalid_nickname", "code_allocation_failed"]);

export function getCreationMarker(storage: MarkerStorage, userId: string): CreationMarker | null {
  const value = storage.getItem(key(userId));
  if (!value) return null;
  // A damaged marker also blocks another creation; it cannot establish non-creation.
  try {
    const marker = JSON.parse(value);
    if (typeof marker.attemptId === "string" && typeof marker.startedAt === "string") return marker;
  } catch {}
  return { attemptId: "unavailable", startedAt: "unavailable" };
}

export function acknowledgeCreatedRoom(storage: MarkerStorage, userId: string) {
  storage.removeItem(key(userId));
}

/** Non-secret recovery marker survives reload; uncertainty never causes a second RPC. */
export async function createWithRecovery(
  storage: MarkerStorage,
  userId: string,
  operation: () => Promise<RoomMembership>,
  timeoutMs = 20000,
): Promise<RoomMembership> {
  if (getCreationMarker(storage, userId)) throw new Error("Check your previous room before creating another one.");
  const marker: CreationMarker = { attemptId: crypto.randomUUID(), startedAt: new Date().toISOString() };
  // Persist before dispatch. Unavailable storage fails closed without sending the RPC.
  storage.setItem(key(userId), JSON.stringify(marker));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(operation).then((membership) => {
    if (getCreationMarker(storage, userId)?.attemptId === marker.attemptId) {
      storage.setItem(key(userId), JSON.stringify({ ...marker, roomId: membership.room.id }));
    }
    return membership;
  }).catch((error) => {
    if (error instanceof RoomOperationError && error.confirmedRoomId) {
      storage.setItem(key(userId), JSON.stringify({ ...marker, roomId: error.confirmedRoomId }));
    } else if (error instanceof RoomOperationError && error.code && knownRejections.has(error.code)) {
      if (getCreationMarker(storage, userId)?.attemptId === marker.attemptId) storage.removeItem(key(userId));
    }
    throw error;
  });
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The room result has not arrived. Check your rooms before trying again.")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
