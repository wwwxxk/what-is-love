export type AnonymousSignInState = {
  interrupted: boolean;
  completed: boolean;
  markAttempt: () => Promise<void>;
  complete: () => Promise<void>;
};
export type AnonymousSignInCoordinator = <T>(operation: (state: AnonymousSignInState) => Promise<T>) => Promise<T>;

type CoordinationEnvironment = {
  locks: Pick<LockManager, "request">;
  storage: {
    getItem: (key: string) => string | null | Promise<string | null>;
    setItem: (key: string, value: string) => unknown | Promise<unknown>;
  };
};
const lockName = "what-is-love:anonymous-session-bootstrap";
const attemptKey = `${lockName}:attempt`;

let database: Promise<IDBDatabase> | undefined;
function markerStorage(): CoordinationEnvironment["storage"] {
  const connect = () => database ??= new Promise((resolve, reject) => {
    const request = window.indexedDB.open("what-is-love-session-coordination", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("attempts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(new Error("Browser storage is required to safely coordinate anonymous sign-in.")); };
    request.onblocked = () => { database = undefined; reject(new Error("Browser session coordination storage is blocked. Close older tabs and retry.")); };
  });
  async function access(key: string, value?: string): Promise<string | null> {
    const db = await connect();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("attempts", value === undefined ? "readonly" : "readwrite");
      const store = transaction.objectStore("attempts");
      const request = value === undefined ? store.get(key) : store.put(value, key);
      transaction.oncomplete = () => resolve(typeof request.result === "string" ? request.result : null);
      transaction.onerror = transaction.onabort = () => reject(new Error("Browser storage is required to safely coordinate anonymous sign-in."));
    });
  }
  return { getItem: (key) => access(key), setItem: (key, value) => access(key, value) };
}

/** Origin-scoped Web Locks never steal an in-flight signup; storage contains no tokens. */
export function createAnonymousSignInCoordinator(environment?: CoordinationEnvironment): AnonymousSignInCoordinator {
  return async (operation) => {
    let runtime = environment;
    if (!runtime) {
      if (typeof window === "undefined" || !window.navigator.locks) {
        throw new Error("This browser cannot safely coordinate anonymous sign-in. Use a current browser over HTTPS.");
      }
      try {
        if (!window.indexedDB) throw new Error("Storage unavailable");
        runtime = { locks: window.navigator.locks, storage: markerStorage() };
      } catch {
        throw new Error("Browser storage is required to safely coordinate anonymous sign-in.");
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const { locks, storage } = runtime;
      return await locks.request(lockName, { mode: "exclusive", signal: controller.signal }, async () => {
        clearTimeout(timer);
        let marker: string | null;
        try { marker = await storage.getItem(attemptKey); }
        catch { throw new Error("Browser storage is required to safely coordinate anonymous sign-in."); }
        return operation({
          interrupted: marker !== null,
          completed: marker === "complete",
          markAttempt: async () => { await storage.setItem(attemptKey, "pending"); },
          complete: async () => { await storage.setItem(attemptKey, "complete"); },
        });
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Another tab is signing in. Wait for it to finish, then retry.");
      }
      throw error;
    } finally { clearTimeout(timer); }
  };
}
