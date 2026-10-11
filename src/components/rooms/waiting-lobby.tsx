"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button, ButtonLink } from "@/components/ui/button";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadLobby, invitationUrl } from "@/features/rooms/lobby-data";
import { acknowledgeCreatedRoom, getCreationMarker } from "@/features/rooms/creation-recovery";

type LobbyData = Awaited<ReturnType<typeof loadLobby>>;
type View = LobbyData | { kind: "loading" | "error" };

export function WaitingLobby({ roomId }: { roomId: string }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [qr, setQr] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const epoch = useRef(0);
  const inFlight = useRef<number | undefined>(undefined);
  const active = useRef(false);
  const userId = useRef<string | undefined>(undefined);
  const invalidate = useCallback(() => { epoch.current++; userId.current = undefined; }, []);

  const refresh = useCallback(async () => {
    const generation = epoch.current;
    if (inFlight.current === generation) return;
    inFlight.current = generation;
    setRefreshing(true);
    try {
      const result = await loadLobby(getSupabaseBrowserClient(), roomId);
      if (!active.current || epoch.current !== generation) return;
      userId.current = result.kind === "ready" ? result.identity.userId : undefined;
      setView(result);
      if (result.kind === "ready") {
        setUpdatedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
        try {
          const marker = getCreationMarker(window.localStorage, result.identity.userId);
          if (marker?.roomId === result.room.id) acknowledgeCreatedRoom(window.localStorage, result.identity.userId);
        } catch { /* Lobby reads do not require recovery storage. */ }
      }
    } catch {
      if (active.current && epoch.current === generation) setView({ kind: "error" });
    } finally {
      if (inFlight.current === generation) inFlight.current = undefined;
      if (active.current && epoch.current === generation) setRefreshing(false);
    }
  }, [roomId]);

  useEffect(() => {
    active.current = true;
    let subscription: { unsubscribe: () => void } | undefined;
    let authTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const client = getSupabaseBrowserClient();
      subscription = client.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT" || (event === "SIGNED_IN" && userId.current && session?.user.id !== userId.current)) {
          invalidate();
          setView({ kind: "missing-session" });
          // Do not await Auth inside its state-change callback.
          authTimer = setTimeout(() => { void refresh(); }, 0);
        }
      }).data.subscription;
    } catch {}
    const initial = setTimeout(() => { void refresh(); }, 0);
    const poll = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active.current = false; invalidate();
      clearTimeout(initial); clearTimeout(authTimer); clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
      subscription?.unsubscribe();
    };
  }, [refresh, invalidate]);

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
        <p role="status" className="mt-3 text-xs leading-relaxed text-muted">Checked {updatedAt || "just now"}. Checks every 15 seconds while this page is visible.</p>
      </section>
      <div className="notice md:col-span-2 md:col-start-1 md:row-start-1" role="status">{view.room.status === "waiting" ? view.participant.role === "organizer" ? "Your group is gathering. You'll be able to start training together." : "Waiting for your group to begin training." : "This room has moved beyond the waiting stage. Ask your organizer about what comes next."}</div>
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
    <p className="mt-6 text-sm text-muted">Return in this browser to keep your nickname and role. Another device won’t recognize you. <Link href="/join" className="text-accent underline underline-offset-4">Use another invitation</Link></p>
  </section>;
}
