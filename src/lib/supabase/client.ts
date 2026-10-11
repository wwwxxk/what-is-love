"use client";

import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseConfig } from "@/lib/config/env";
import type { Database } from "./database.types";
import { getSessionCookieOptions } from "./session-cookie-options";

/** Cookie-backed singleton: call only from a feature, never on homepage render. */
export function getSupabaseBrowserClient() {
  const config = requireSupabaseConfig();
  return createBrowserClient<Database>(config.url, config.publishableKey, {
    cookieOptions: getSessionCookieOptions(),
    // A transport failure must reach the UI; never retry an uncertain admission.
    db: { retry: false },
  });
}
