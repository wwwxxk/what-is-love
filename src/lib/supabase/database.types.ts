import type { ParticipantRole, RoomStatus } from "../../features/rooms/types.ts";

// Hand-maintained against the reviewed migration; regenerate after live application.
export type Room = {
  id: string;
  join_code: string;
  status: RoomStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
};

export type RoomParticipant = {
  id: string;
  room_id: string;
  auth_user_id: string;
  nickname: string;
  role: ParticipantRole;
  joined_at: string;
  updated_at: string;
};

type EmptySchema = { [_ in never]: never };
export type RoomRpcResult = { room_id: string | null; participant_id: string | null; error_code: string | null };
type MembershipResult = RoomRpcResult[];

export type Database = {
  public: {
    Tables: {
      rooms: {
        Row: Room;
        Insert: Pick<Room, "join_code" | "created_by"> & Partial<Omit<Room, "join_code" | "created_by">>;
        Update: Partial<Room>;
        Relationships: [];
      };
      room_participants: {
        Row: RoomParticipant;
        Insert: Pick<RoomParticipant, "room_id" | "auth_user_id" | "nickname"> & Partial<Omit<RoomParticipant, "room_id" | "auth_user_id" | "nickname">>;
        Update: Partial<RoomParticipant>;
        Relationships: [{
          foreignKeyName: "room_participants_room_id_fkey";
          columns: ["room_id"];
          isOneToOne: false;
          referencedRelation: "rooms";
          referencedColumns: ["id"];
        }];
      };
    };
    Views: EmptySchema;
    Functions: {
      create_robot_room: { Args: { p_nickname: string }; Returns: MembershipResult };
      join_robot_room: { Args: { p_join_code: string; p_nickname: string }; Returns: MembershipResult };
    };
    Enums: { room_status: RoomStatus; participant_role: ParticipantRole };
    CompositeTypes: EmptySchema;
  };
};
