export type SupabaseConfig = Readonly<{
  url: string;
  publishableKey: string;
}>;

type PublicEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
};

/** Validate only on use: Phase 0 must render without database configuration. */
export function readSupabaseConfig(env: PublicEnvironment): SupabaseConfig | null {
  const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const rawKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const url = rawUrl === "https://your-project.supabase.co" ? "" : rawUrl;
  const publishableKey = rawKey === "your-supabase-publishable-key" ? "" : rawKey;

  if (!url && !publishableKey) return null;
  if (!url || !publishableKey) {
    throw new Error("Set both NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid HTTPS URL (HTTP is allowed for localhost development).");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname);
  if (
    (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && isLocal)) ||
    parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash ||
    parsedUrl.pathname !== "/"
  ) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be an HTTPS origin without credentials, path, query, or fragment (localhost HTTP is allowed).");
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key. Never use a secret or service-role key.");
  }

  return { url: parsedUrl.origin, publishableKey };
}

export function getSupabaseConfig(): SupabaseConfig | null {
  // Explicit references let Next.js include only these public values in the browser.
  return readSupabaseConfig({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
