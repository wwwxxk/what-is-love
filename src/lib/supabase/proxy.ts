import { createServerClient, type CookieMethodsServer, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server.js";
import { getSupabaseConfig, type SupabaseConfig } from "../config/env.ts";
import type { Database } from "./database.types.ts";
import { getSessionCookieOptions } from "./session-cookie-options.ts";

type RefreshClientFactory = (
  url: string,
  key: string,
  options: { cookies: CookieMethodsServer; cookieOptions: CookieOptions },
) => { auth: { getUser: () => Promise<unknown> } };

/** Optional factories allow cookie transport to be tested without a live Auth API. */
export async function updateParticipantSession(
  request: NextRequest,
  createClient: RefreshClientFactory = (url, key, options) => createServerClient<Database>(url, key, options),
  readConfig: () => SupabaseConfig | null = getSupabaseConfig,
) {
  const hasSessionCookie = request.cookies.getAll().some(({ name }) =>
    /^sb-[A-Za-z0-9_-]+-auth-token(?:\.\d+)?$/.test(name));
  if (!hasSessionCookie) return NextResponse.next({ request });

  const config = readConfig();
  if (!config) return NextResponse.next({ request });

  const pendingCookies = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const cookieOptions = getSessionCookieOptions();
  const cacheHeaders = new Headers({ "Cache-Control": "private, no-store" });
  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  const client = createClient(config.url, config.publishableKey, {
    cookieOptions,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headersToSet) => {
        for (const cookie of cookiesToSet) {
          request.cookies.set(cookie.name, cookie.value);
          pendingCookies.set(cookie.name, { ...cookie, options: { ...cookie.options, ...cookieOptions } });
        }
        for (const [name, value] of Object.entries(headersToSet)) cacheHeaders.set(name, value);
        cacheHeaders.set("Cache-Control", "private, no-store");
        response = NextResponse.next({ request });
        for (const cookie of pendingCookies.values()) response.cookies.set(cookie.name, cookie.value, cookie.options);
        for (const [name, value] of cacheHeaders) response.headers.set(name, value);
      },
    },
  });
  // Verifies identity and refreshes cookies. Protected operations independently
  // verify identity and rely on DB authorization; this proxy grants no access.
  await client.auth.getUser();
  return response;
}
