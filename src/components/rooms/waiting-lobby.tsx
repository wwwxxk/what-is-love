"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button, ButtonLink } from "@/components/ui/button";
import { invitationUrl } from "@/features/rooms/lobby-data";
import { acknowledgeCreatedRoom, getCreationMarker } from "@/features/rooms/creation-recovery";

import { useRoomSynchronization } from "@/features/rooms/use-room-synchronization";
import { canStartTraining } from "@/features/rooms/synchronization";
import { StartConfirmation } from "./start-confirmation";
import { TrainingPreparation } from "./training-preparation";

export function WaitingLobby({ roomId }: { roomId: string }) {
  const sync = useRoomSynchronization(roomId);
  const { view, refreshing, refresh } = sync;
  const [confirming, setConfirming] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [qr, setQr] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  useEffect(() => {
    if (view.kind === "ready") {
      try {
        const marker = getCreationMarker(window.localStorage, view.identity.userId);
        if (marker?.roomId === view.room.id) acknowledgeCreatedRoom(window.localStorage, view.identity.userId);
      } catch { /* Room access does not require recovery storage. */ }
    }
  }, [view]);

  const invitationCode = view.kind === "ready" ? view.room.join_code : "";
  useEffect(() => {
    let current = true;
    if (invitationCode) {
      const url = invitationUrl(window.location.origin, invitationCode);
      void QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 }).then((svg) => {
        if (current) { setShareUrl(url); setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`); }
      }).catch(() => { if (current) { setShareUrl(url); setQr(""); } });
    }
    return () => { current = false; };
  }, [invitationCode]);

  async function copyInvitation() {
    try { await navigator.clipboard.writeText(shareUrl); setCopyMessage("Invitation link copied."); }
    catch { setCopyMessage("Select and copy the invitation link below."); }
  }

  if (view.kind !== "ready") return <section className="mx-auto mt-8 max-w-xl">
    <p className="eyebrow">Your shared beginning</p><h1 className="mt-3 text-4xl font-semibold tracking-tight">Waiting Lobby</h1>
    {view.kind === "loading" ? <p role="status" className="mt-6 text-muted">Checking your saved place and opening your room…</p> : <div className="panel mt-6">
      <h2 className="text-xl font-semibold">{view.kind === "missing-session" ? "We can’t find your saved place" : view.kind === "unavailable" ? "This room isn’t available to you" : "We couldn’t load this room"}</h2>
      <p className="mt-3 leading-relaxed text-muted">{view.kind === "missing-session" ? "Try the browser where you first joined. If your saved place is lost, an invitation may let you join a waiting room as someone new, but it won’t bring back your organizer role or old membership." : view.kind === "unavailable" ? "Check your invitation with the organizer and use the browser where you joined. Room details are available only to its members." : "Check your connection and try opening the room again. We haven’t signed you in as someone new."}</p>
      <Button onClick={() => { void refresh(); }} disabled={refreshing} className="mt-5">{refreshing ? "Opening your room…" : "Return to my room"}</Button>
      <ButtonLink href="/join" variant="secondary" className="mt-3 w-full">Use an invitation</ButtonLink>
    </div>}
  </section>;

  if (view.room.status === "task_assignment") return <>
    <TrainingPreparation snapshot={view} />
    <div className="mx-auto mt-6 max-w-4xl"><Button variant="secondary" onClick={() => { void refresh(); }} disabled={refreshing}>Check room</Button>
      <p role="status" className="mt-3 text-xs text-muted">{sync.connection === "live" ? "Live room updates are connected." : "Checking your room over your connection."} Checks every 15 seconds while visible.</p>
    </div>
  </>;
  if (view.room.status !== "waiting") return <section className="mx-auto mt-8 max-w-xl">
    <p className="eyebrow">Your shared experience</p><h1 className="mt-3 text-4xl font-semibold">Your room has moved ahead</h1>
    <p className="mt-4 text-muted">You’re here as {view.participant.nickname}. Your group is in a later stage. This screen supports the waiting room and Training Preparation.</p>
    <Button className="mt-6" onClick={() => { void refresh(); }} disabled={refreshing}>Check room</Button>
  </section>;

  return <section className="mx-auto mt-8 max-w-4xl" aria-labelledby="lobby-title">
    <p className="eyebrow">Your shared beginning</p>
    <h1 id="lobby-title" className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Waiting Lobby</h1>
    <p className="mt-4 text-muted">You’re here as <strong className="text-ink">{view.participant.nickname}</strong> · {view.participant.role === "organizer" ? "Organizer" : "Participant"}</p>
    <div className="mt-6 grid gap-6 md:grid-cols-[1fr_1.15fr]">
      <section className="panel min-w-0 md:col-start-2 md:row-start-2" aria-labelledby="members-title">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="members-title" className="text-xl font-semibold">In this room</h2><span className="rounded-full bg-accent-soft px-3 py-1 text-sm text-accent">{view.members.length} {view.members.length === 1 ? "member" : "members"}</span></div>
        <ul className="mt-5 divide-y divide-line">{view.members.map((member) => <li key={member.id} className="flex items-start justify-between gap-3 py-4">
          <span className="min-w-0 break-words font-medium">{member.nickname}{member.id === view.participant.id && <span className="ml-2 text-xs font-normal text-muted">You</span>}</span>
          <span className="shrink-0 text-xs text-muted">{member.role === "organizer" ? "Organizer" : "Participant"}</span>
        </li>)}</ul>
        <Button variant="secondary" onClick={() => { void refresh(); }} disabled={refreshing} className="mt-4 w-full">{refreshing ? "Refreshing…" : "Refresh members"}</Button>
        <p role="status" className="mt-3 text-xs leading-relaxed text-muted">{sync.connection === "live" ? "Live room updates are connected." : sync.connection === "connecting" ? "Connecting live updates. Your room still checks every 15 seconds." : "Live updates are reconnecting. Your room still checks every 15 seconds."} Checks pause while this page is hidden.</p>
      </section>
      <div className="notice md:col-span-2 md:col-start-1 md:row-start-1">
        <p role="status">{view.room.status === "waiting" ? view.participant.role === "organizer" ? "Your group is gathering. You can start training whenever you’re ready." : "Waiting for your group to begin training." : "This room has moved beyond the waiting stage. Ask your organizer about what comes next."}</p>
        {canStartTraining(view) && <Button className="mt-4" disabled={sync.startPending || refreshing} onClick={() => setConfirming(true)}>{sync.startPending ? "Checking training…" : "Start Training"}</Button>}
        {sync.notice && <p role="alert" className="mt-4">{sync.notice}</p>}
      </div>
      <section className="panel min-w-0 md:col-start-1 md:row-start-2" aria-labelledby="invitation-title">
        <h2 id="invitation-title" className="text-xl font-semibold">Invite your people</h2>
        <p className="mt-4 text-xs text-muted">Room invitation code</p>
        <p className="mt-2 break-all font-mono text-2xl font-semibold tracking-widest sm:text-3xl">{view.room.join_code}</p>
        {shareUrl && <><Button onClick={copyInvitation} className="mt-5 w-full">Copy invitation link</Button>
          <label htmlFor="invite-link" className="field-label mt-4">Invitation link</label><input id="invite-link" className="text-field text-sm" readOnly value={shareUrl} onFocus={(event) => event.target.select()} />
          <p role="status" className="mt-2 text-sm text-muted">{copyMessage || "Share the link above or expand the QR code below."}</p></>}
        {qr && <details className="mt-4 rounded-control border border-line p-4">
          <summary className="qr-summary cursor-pointer text-sm font-medium">QR code invitation</summary>
          <Image src={qr} alt="QR code for this room’s invitation link" width={224} height={224} unoptimized className="mx-auto mt-4 w-full max-w-56 rounded-control" />
          <p className="mt-3 text-center text-sm text-muted">Scan with a phone to open this room’s invitation.</p>
        </details>}
      </section>
    </div>
    <StartConfirmation open={confirming && canStartTraining(view)} cancel={() => setConfirming(false)} confirm={() => { setConfirming(false); void sync.start(); }} />
    <p className="mt-6 text-sm text-muted">Return in this browser to keep your nickname and role. Another device won’t recognize you. <Link href="/join" className="text-accent underline underline-offset-4">Use another invitation</Link></p>
  </section>;
}
