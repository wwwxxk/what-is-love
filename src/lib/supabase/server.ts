import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireSupabaseConfig } from "@/lib/config/env";
import type { Database } from "./database.types";
import { getSessionCookieOptions } from "./session-cookie-options";

/** Route Handlers must attach responseHeaders to the returned Response, preventing token caching. */
export async function getSupabaseServerClient(responseHeaders: Headers) {
  const config = requireSupabaseConfig();

  const cookieStore = await cookies();
  const cookieOptions = getSessionCookieOptions();
  responseHeaders.set("Cache-Control", "private, no-store");
  return createServerClient<Database>(config.url, config.publishableKey, {
    cookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet, cacheHeaders) => {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, { ...options, ...cookieOptions });
        }
        for (const [name, value] of Object.entries(cacheHeaders)) responseHeaders.set(name, value);
        responseHeaders.set("Cache-Control", "private, no-store");
      },
    },
  });
}
