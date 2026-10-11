import { Suspense } from "react";
import type { Metadata } from "next";
import { RoomShell } from "@/components/rooms/room-shell";
import { WaitingLobby } from "@/components/rooms/waiting-lobby";

export const metadata: Metadata = { title: "Your Room · WHAT IS LOVE?", robots: { index: false, follow: false } };
export default function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  return <RoomShell><Suspense fallback={<p role="status" className="mt-8">Opening your room…</p>}>
    <RoomContent params={params} />
  </Suspense></RoomShell>;
}
async function RoomContent({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <WaitingLobby key={roomId} roomId={roomId} />;
}
