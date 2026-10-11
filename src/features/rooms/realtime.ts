import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../lib/supabase/database.types.ts";
import type { ConnectionStatus, RoomTransport } from "./synchronization.ts";

type Observer = { changed: () => void; status: (status: ConnectionStatus) => void };
type Hub = { observers: Set<Observer>; closed: boolean; channel?: RealtimeChannel; status?: ConnectionStatus };
// The SDK deduplicates by topic. Lease it once per singleton client so Strict Mode,
// remounts or two consumers cannot unsubscribe each other's owned subscription.
const registries = new WeakMap<SupabaseClient<Database>, {
  hubs: Map<string, Hub>; removals: Map<string, Promise<unknown>>;
}>();
export function roomRealtimeTransport(client: SupabaseClient<Database>): RoomTransport {
  let registry = registries.get(client);
  if (!registry) { registry = { hubs: new Map(), removals: new Map() }; registries.set(client, registry); }
  const owned = registry;
  return {
    subscribe(topic, changed, status) {
      const observer = { changed, status };
      let hub = owned.hubs.get(topic);
      if (!hub) {
        hub = { observers: new Set(), closed: false }; owned.hubs.set(topic, hub);
        const entry = hub;
        const notify = (next: ConnectionStatus) => {
          if (!entry.closed) { entry.status = next; for (const listener of entry.observers) listener.status(next); }
        };
        void (async () => {
          try {
            await owned.removals.get(topic);
            await client.realtime.setAuth(); // SDK token transport; getUser verified identity first.
            if (entry.closed) return;
            if (client.getChannels().some((channel) => channel.topic === "realtime:" + topic)) {
              notify("CHANNEL_ERROR"); return; // Never take over an unowned/public channel.
            }
            entry.channel = client.channel(topic, { config: { private: true, presence: { enabled: false } } });
            entry.channel.on("broadcast", { event: "room_changed" }, () => {
              if (!entry.closed) for (const listener of entry.observers) listener.changed();
            }).subscribe((next) => notify(next));
          } catch { notify("CHANNEL_ERROR"); }
        })();
      }
      const entry = hub;
      entry.observers.add(observer);
      if (entry.status) queueMicrotask(() => { if (entry.observers.has(observer)) status(entry.status!); });
      return () => {
        entry.observers.delete(observer);
        if (entry.observers.size || entry.closed) return;
        entry.closed = true;
        if (owned.hubs.get(topic) === entry) owned.hubs.delete(topic);
        if (entry.channel) {
          const channel = entry.channel;
          const removing = client.removeChannel(channel).catch(() => {}).finally(() => channel.teardown());
          owned.removals.set(topic, removing);
          void removing.finally(() => { if (owned.removals.get(topic) === removing) owned.removals.delete(topic); });
        }
      };
    },
  };
}
