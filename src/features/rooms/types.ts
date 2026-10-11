export const ROOM_STATUSES = [
  "waiting", "task_assignment", "creating", "gallery", "awakening",
  "robot_ready", "conversation", "voting", "finished",
] as const;

export type RoomStatus = (typeof ROOM_STATUSES)[number];
export type ParticipantRole = "organizer" | "participant";
export type CreateRoomInput = Readonly<{ nickname: string }>;
export type JoinRoomInput = Readonly<{ joinCode: string; nickname: string }>;
