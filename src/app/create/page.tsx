import type { Metadata } from "next";
import { RoomShell } from "@/components/rooms/room-shell";
import { AdmissionForm } from "@/components/rooms/admission-form";

export const metadata: Metadata = { title: "Create a Robot · WHAT IS LOVE?" };
export default function CreatePage() {
  return <RoomShell><AdmissionForm mode="create" /></RoomShell>;
}
