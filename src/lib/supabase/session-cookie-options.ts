import type { CookieOptions } from "@supabase/ssr";

/** All clients use the same policy. Production must be served over HTTPS. */
export function getSessionCookieOptions(environment = process.env.NODE_ENV): CookieOptions {
  return { path: "/", sameSite: "lax", httpOnly: false, secure: environment === "production" };
}
