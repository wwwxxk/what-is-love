"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ensureAnonymousParticipant, restoreParticipantSession } from "@/features/auth/participant-session";
import { createRoom, getCreatedRooms, joinRoom, RoomOperationError } from "@/features/rooms/data-access";
import { createWithRecovery, getCreationMarker, type CreationMarker } from "@/features/rooms/creation-recovery";
import { normalizeJoinCode, validateNickname } from "@/features/rooms/validation";
import type { Room } from "@/lib/supabase/database.types";

export function AdmissionForm({ mode, initialCode = "" }: { mode: "create" | "join"; initialCode?: string }) {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [authFailure, setAuthFailure] = useState(false);
  const [explicitRetry, setExplicitRetry] = useState(false);
  const [pending, setPending] = useState<CreationMarker | null>(null);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const submitting = useRef(false);
  const errorPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    async function recoverMarker() {
      try {
        const identity = await restoreParticipantSession(getSupabaseBrowserClient());
        if (active && identity && mode === "create") setPending(getCreationMarker(window.localStorage, identity.userId));
      } catch {
        // Submission verifies identity again and reports errors; never signs up here.
      }
    }
    void recoverMarker();
    return () => { active = false; };
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending) return;
    submitting.current = true;
    setError(""); setAuthFailure(false);
    let actor: string | undefined;
    let dispatchStarted = false;
    let authenticating = false;
    try {
      const displayName = validateNickname(nickname);
      const invitation = mode === "join" ? normalizeJoinCode(code) : "";
      setNickname(displayName);
      if (mode === "join") setCode(invitation);
      setBusy("Checking this browser…");
      authenticating = true;
      const client = getSupabaseBrowserClient();
      const identity = await ensureAnonymousParticipant(client, { retryInterruptedSignIn: explicitRetry });
      actor = identity.userId;
      authenticating = false;
      setBusy(mode === "create" ? "Creating your room…" : "Joining your room…");
      const membership = mode === "create"
        ? await createWithRecovery(window.localStorage, actor, () => {
          dispatchStarted = true;
          return createRoom(client, { nickname: displayName });
        })
        : await joinRoom(client, { joinCode: invitation, nickname: displayName });
      router.replace(`/rooms/${membership.room.id}`);
    } catch (failure) {
      if (mode === "create" && actor) {
        try { setPending(getCreationMarker(window.localStorage, actor)); } catch {}
      }
      if (authenticating) {
        setAuthFailure(true);
        setError("We couldn’t confirm who you are in this browser. Try again here or check the browser you used before. We haven’t signed you in as someone new.");
      } else if (mode === "create" && dispatchStarted && !(failure instanceof RoomOperationError && failure.code)) {
        const confirmedRoomId = failure instanceof RoomOperationError ? failure.confirmedRoomId : undefined;
        setPending((previous) => previous ?? { attemptId: "unknown", startedAt: new Date().toISOString(), roomId: confirmedRoomId });
        setError(confirmedRoomId ? "Your room was created, but its details haven’t loaded yet. Return to its lobby to try again." : "We couldn’t confirm whether your room was created. Look for your room before trying to create another.");
      } else if (failure instanceof RoomOperationError) {
        const messages: Record<string, string> = {
          rate_limited: "Too many requests. Please wait before trying again.",
          room_quota_exceeded: "You’ve reached the room limit. Return to an existing room below or ask for help.",
          membership_quota_exceeded: "Your room membership limit has been reached. Ask the organizer for help.",
          invalid_nickname: "Enter a nickname of 1 to 40 characters without control characters.",
          room_unavailable: "This invitation is unavailable. Check the code with the organizer; the room may no longer accept participants.",
          code_allocation_failed: "A room invitation could not be allocated. Please try again later.",
        };
        setError(messages[failure.code ?? ""] ?? "We couldn’t confirm this request. Check your session and invitation before trying again.");
      } else if (!actor && !authenticating && failure instanceof Error) {
        // Only validation runs before authentication. Never render a transport error.
        setError(failure.message);
      } else {
        setError("This browser needs permission to save your place before creating a room. Allow site storage and try again; we won’t create a room until it is available.");
      }
      requestAnimationFrame(() => errorPanel.current?.focus());
      setBusy("");
      submitting.current = false;
    }
  }

  async function checkRooms() {
    if (submitting.current) return;
    submitting.current = true; setBusy("Checking your rooms…"); setRecoveryMessage("");
    try {
      const client = getSupabaseBrowserClient();
      const identity = await restoreParticipantSession(client);
      if (!identity) throw new Error("Missing session");
      setPending(getCreationMarker(window.localStorage, identity.userId));
      setRooms(await getCreatedRooms(client));
    } catch {
      setRecoveryMessage("We couldn’t find your rooms. Try the browser you used to create them. A nickname or invitation won’t bring back a lost organizer role.");
    } finally { submitting.current = false; setBusy(""); }
  }

  return <section className="mx-auto mt-8 max-w-xl" aria-labelledby="admission-title">
    <p className="eyebrow">A little connection, a shared beginning</p>
    <h1 id="admission-title" className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">{mode === "create" ? "Create a Robot" : "Join a Robot"}</h1>
    <p className="mt-4 leading-relaxed text-muted">{mode === "create" ? "First, create a room. Your group will bring the robot to life together." : "Bring your invitation and a name you’d like the room to know you by."}</p>
    {mode === "create" && <p className="mt-2 text-sm text-muted">You’ll be the organizer, with an invitation to share.</p>}

    {error && <div ref={errorPanel} role="alert" tabIndex={-1} className="notice notice--error mt-6">{error}</div>}
    {pending && <div className="panel mt-6" aria-label="Room recovery">
      <h2 className="text-lg font-semibold">Find your room</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{pending.roomId ? "Your room was created. Return to its lobby to load its details." : "Your last request may have created a room. We won’t create another until we can confirm what happened."} Stay in this browser to keep your place as organizer.</p>
      {pending.roomId && <ButtonLink href={`/rooms/${encodeURIComponent(pending.roomId)}`} className="mt-4">Return to my room</ButtonLink>}
    </div>}

    <form onSubmit={submit} noValidate aria-busy={!!busy} className="mt-7 space-y-5">
      {mode === "join" && <div>
        <label htmlFor="invitation-code" className="field-label">Room invitation code</label>
        <input id="invitation-code" name="code" className="text-field font-mono" value={code} onChange={(event) => setCode(event.target.value)} maxLength={32} autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="ABCD-EFGH-JKLM" aria-describedby="code-help" disabled={!!busy} />
        <p id="code-help" className="mt-2 text-sm text-muted">12 characters. Lowercase and grouping hyphens are welcome.</p>
      </div>}
      <div>
        <label htmlFor="nickname" className="field-label">Your nickname</label>
        <input id="nickname" name="nickname" className="text-field" value={nickname} onChange={(event) => setNickname(event.target.value)} autoComplete="nickname" placeholder="What should we call you?" aria-describedby="nickname-help" disabled={!!busy || !!pending} />
        <p id="nickname-help" className="mt-2 text-sm text-muted">1–40 characters. Use a name you’re comfortable sharing with this room.</p>
      </div>
      {authFailure && <div className="notice">
        <p className="text-sm leading-relaxed">We’ll check for your saved place first. If it’s gone, choosing to try again may let you continue as someone new. Your old membership and organizer role won’t carry over.</p>
        <label className="mt-3 flex items-start gap-3 text-sm"><input type="checkbox" checked={explicitRetry} onChange={(event) => setExplicitRetry(event.target.checked)} className="mt-1 size-4 shrink-0" />I understand and agree to continue as someone new if my saved place is missing.</label>
      </div>}
      <Button type="submit" disabled={!!busy || !!pending} className="w-full">{busy || (mode === "create" ? "Create my Robot" : "Join this Robot")}</Button>
      <p role="status" className="text-sm text-muted">{busy ? "Please keep this page open while we confirm your request." : "Your place is saved in this browser. Another device won’t recognize you; clearing site data can lose your place."}</p>
    </form>

    {mode === "create" && <div className="mt-6 border-t border-line pt-6">
      <Button variant="secondary" disabled={!!busy} onClick={checkRooms} className="w-full">Return to my room</Button>
      <p className="mt-2 text-sm text-muted">Look for rooms you created in this browser.</p>
      {recoveryMessage && <p role="alert" className="mt-3 text-sm text-muted">{recoveryMessage}</p>}
      {rooms && <div className="mt-4" aria-live="polite">
        {rooms.length === 0 ? <p className="text-sm text-muted">No room you created is available here yet. If your last request may still be finishing, wait and check again before creating another.</p> : <ul className="space-y-2">{rooms.map((room) => <li key={room.id}><Link className="flex flex-wrap justify-between gap-2 rounded-control border border-line p-4" href={`/rooms/${room.id}`}><span className="font-mono">{room.join_code}</span><span className="text-sm text-muted">Return to room →</span></Link></li>)}</ul>}
      </div>}
    </div>}
    <p className="mt-7 text-center text-sm text-muted">{mode === "create" ? "Already have an invitation?" : "Starting something new?"} <Link href={mode === "create" ? "/join" : "/create"} className="font-medium text-accent underline underline-offset-4">{mode === "create" ? "Join a Robot" : "Create a Robot"}</Link></p>
  </section>;
}
