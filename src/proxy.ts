import type { NextRequest } from "next/server";
import { updateParticipantSession } from "@/lib/supabase/proxy";

/** Refresh existing sessions; never create an anonymous account just by visiting. */
export async function proxy(request: NextRequest) {
  return updateParticipantSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
