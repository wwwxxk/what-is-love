"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase/client";
import { getRoomSnapshot, startRoom } from "./lifecycle";
import { roomRealtimeTransport } from "./realtime";
import { createRoomSynchronization, initialSyncState } from "./synchronization";

export function useRoomSynchronization(roomId: string) {
  const [state, setState] = useState(initialSyncState);
  const owned = useRef<ReturnType<typeof createRoomSynchronization> | undefined>(undefined);
  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    let tokenTimer: ReturnType<typeof setTimeout> | undefined;
    let observedUserId: string | undefined;
    const initial = setTimeout(() => {
      try {
        const client = getSupabaseBrowserClient();
        const controller = createRoomSynchronization({
          load: (signal) => getRoomSnapshot(client, roomId, signal),
          start: (userId, signal) => startRoom(client, roomId, userId, signal),
          transport: roomRealtimeTransport(client), changed: setState,
        });
        owned.current = controller;
        subscription = client.auth.onAuthStateChange((event, session) => {
          const current = controller.getState().view;
          const previous = current.kind === "ready" ? current.identity.userId : observedUserId;
          const next = session?.user.id;
          if (event === "SIGNED_OUT" || (previous && next !== previous
            && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED"))) {
            controller.identityChanged();
          } else if (event === "TOKEN_REFRESHED") {
            clearTimeout(tokenTimer); tokenTimer = setTimeout(() => controller.recover(), 0);
          }
          observedUserId = next;
        }).data.subscription;
        controller.setVisible(document.visibilityState === "visible");
        controller.run();
      } catch { setState({ ...initialSyncState, view: { kind: "error" }, connection: "polling" }); }
    }, 0);
    const visible = () => owned.current?.setVisible(document.visibilityState === "visible");
    const online = () => owned.current?.recover();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    return () => {
      clearTimeout(initial); clearTimeout(tokenTimer);
      owned.current?.stop(); owned.current = undefined; subscription?.unsubscribe();
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", online);
    };
  }, [roomId]);
  return { ...state, refresh: () => owned.current?.refresh(), start: () => owned.current?.startTraining() };
}
