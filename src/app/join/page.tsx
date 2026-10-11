import { Suspense } from "react";
import type { Metadata } from "next";
import { RoomShell } from "@/components/rooms/room-shell";
import { AdmissionForm } from "@/components/rooms/admission-form";

export const metadata: Metadata = { title: "Join a Robot · WHAT IS LOVE?" };
export default function JoinPage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  return <RoomShell><Suspense fallback={<p role="status" className="mt-8">Opening your invitation…</p>}>
    <JoinContent searchParams={searchParams} />
  </Suspense></RoomShell>;
}
async function JoinContent({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const { code } = await searchParams;
  return <AdmissionForm mode="join" initialCode={typeof code === "string" ? code : ""} />;
}
