import { RoomOperationError } from "./data-access.ts";
import { compareRoomVersions, type RoomSnapshot, type SnapshotResult } from "./lifecycle.ts";

export type ConnectionStatus = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED";
export type RoomTransport = {
  subscribe: (topic: string, changed: () => void, status: (status: ConnectionStatus) => void) => () => void;
};
export type SyncState = {
  view: SnapshotResult | { kind: "loading" | "error" };
  refreshing: boolean; connection: "connecting" | "live" | "polling";
  startPending: boolean; notice: string;
};
type Options = {
  load: (signal: AbortSignal) => Promise<SnapshotResult>;
  start: (userId: string, signal: AbortSignal) => Promise<unknown>;
  transport: RoomTransport;
  changed: (state: SyncState) => void;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
  timeoutMs?: number;
};
export const initialSyncState: SyncState = {
  view: { kind: "loading" }, refreshing: false, connection: "connecting", startPending: false, notice: "",
};
export function membershipTopic(snapshot: RoomSnapshot): string {
  return "wil:room:" + snapshot.room.id + ":member:" + snapshot.participant.id;
}
export function canStartTraining(snapshot: RoomSnapshot): boolean {
  return snapshot.room.status === "waiting" && snapshot.participant.role === "organizer"
    && snapshot.room.created_by === snapshot.identity.userId;
}

/** Messages invalidate; snapshots authorize. Owns polling, generations and leases. */
export function createRoomSynchronization(options: Options) {
  const schedule = options.schedule ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms); return () => clearTimeout(timer);
  });
  let state: SyncState = { ...initialSyncState };
  let active = false, visible = true, epoch = 0, dirty = false;
  let draining: Promise<void> | undefined;
  let latest: RoomSnapshot | undefined;
  let read: AbortController | undefined, write: AbortController | undefined;
  let cancelPoll: (() => void) | undefined, cancelRecovery: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined, topic = "", channelEpoch = 0;
  const publish = (patch: Partial<SyncState>) => {
    state = { ...state, ...patch }; if (active) options.changed(state);
  };
  function detach() {
    channelEpoch++; const release = unsubscribe; unsubscribe = undefined; topic = "";
    release?.();
  }
  function resetIdentity() {
    epoch++; read?.abort(); write?.abort(); latest = undefined; detach();
    publish({ view: { kind: "missing-session" }, refreshing: false, startPending: false, notice: "", connection: "polling" });
  }
  async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, controller: AbortController): Promise<T> {
    let cancel: () => void = () => {};
    let abort: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Request interrupted."));
      controller.signal.addEventListener("abort", abort, { once: true });
      cancel = schedule(() => {
        reject(new Error("The room check timed out. Try again when your connection returns."));
        controller.abort();
      }, options.timeoutMs ?? 20000);
    });
    try { return await Promise.race([operation(controller.signal), interrupted]); }
    finally { cancel(); controller.signal.removeEventListener("abort", abort); }
  }
  function bind(snapshot: RoomSnapshot) {
    const next = membershipTopic(snapshot);
    if (topic === next && unsubscribe) return;
    detach(); topic = next;
    const binding = channelEpoch;
    publish({ connection: "connecting" });
    try {
      unsubscribe = options.transport.subscribe(next, () => {
        if (active && visible && binding === channelEpoch) void refresh();
      }, (status) => {
        if (!active || binding !== channelEpoch) return;
        publish({ connection: status === "SUBSCRIBED" ? "live" : "polling" });
        // Close the snapshot-to-subscribe gap and reauthorize after reconnect/error.
        if (visible) void refresh();
      });
    } catch { publish({ connection: "polling" }); }
  }
  async function drain() {
    while (active && dirty) {
      dirty = false; const generation = epoch;
      const controller = new AbortController(); read = controller;
      publish({ refreshing: true });
      try {
        const result = await bounded(options.load, controller);
        if (!active || generation !== epoch) continue;
        if (result.kind !== "ready") {
          latest = undefined; detach();
          publish({ view: result, connection: "polling" });
        } else {
          if (latest && latest.identity.userId === result.identity.userId
            && compareRoomVersions(result.version, latest.version) < 0) continue;
          if (latest && latest.identity.userId !== result.identity.userId) detach();
          latest = result; publish({ view: result }); bind(result);
        }
      } catch {
        if (active && generation === epoch) {
          // Hide previously personalized content until verification succeeds.
          detach();
          publish({ view: { kind: "error" }, connection: "polling" });
        }
      } finally {
        if (read === controller) read = undefined;
        if (active && generation === epoch) publish({ refreshing: false });
      }
    }
  }
  function refresh(): Promise<void> {
    if (!active) return Promise.resolve();
    dirty = true;
    if (!draining) {
      // Defer so synchronous subscription callbacks can safely join this drain.
      const operation = Promise.resolve().then(drain);
      draining = operation;
      void operation.finally(() => {
        if (draining === operation) draining = undefined;
        if (active && dirty) void refresh();
      });
    }
    return draining;
  }
  function poll() {
    cancelPoll = schedule(() => { if (visible) void refresh(); if (active) poll(); }, 15000);
  }
  return {
    getState: () => state,
    run() { if (!active) { active = true; poll(); void refresh(); } },
    refresh,
    setVisible(next: boolean) { visible = next; if (next && active) void refresh(); },
    recover() { if (active && visible) void refresh(); },
    identityChanged() {
      if (!active) return;
      resetIdentity(); cancelRecovery?.();
      // Never call/await Auth from inside its state-change callback.
      cancelRecovery = schedule(() => { cancelRecovery = undefined; void refresh(); }, 0);
    },
    async startTraining() {
      if (!active || state.startPending || state.view.kind !== "ready" || !canStartTraining(state.view)) return;
      const generation = epoch, userId = state.view.identity.userId;
      const controller = new AbortController(); write = controller;
      publish({ startPending: true, notice: "" });
      try { await bounded((signal) => options.start(userId, signal), controller); }
      catch (error) {
        if (active && generation === epoch) {
          publish({ notice: error instanceof RoomOperationError && error.code
            ? error.message : "We couldn't confirm that request. Checking whether training has started; no new request was sent." });
        }
      } finally {
        if (write === controller) write = undefined;
        if (active && generation === epoch) {
          await refresh(); // Includes uncertain/HTTP-200 rejection outcomes.
          if (active && generation === epoch) publish({ startPending: false });
        }
      }
    },
    stop() {
      active = false; epoch++; dirty = false; read?.abort(); write?.abort();
      cancelPoll?.(); cancelRecovery?.(); detach();
    },
  };
}
