# WHAT IS LOVE?

A collaborative transmedia storytelling experience about love and belonging.

Phase 1A adds a version-controlled backend foundation: SQL migrations, anonymous Auth
session helpers, cookie refresh, RLS, and typed room creation/joining/read operations.
The migrations have **not been applied to the live Supabase project**. The Phase 0
homepage is unchanged; both actions remain disabled. Room UI, contributions,
realtime subscriptions, and AI are not implemented.

## Development

Use Node.js 24 LTS (`.nvmrc`) and npm. This project's checks use Node 24's built-in
TypeScript support; the Supabase SDK itself requires Node 22 or newer.
Dependencies use stable versions pinned in `package-lock.json`:
Next.js App Router, React, TypeScript, Tailwind CSS 4, and Supabase JS / SSR.
TypeScript stays on 6.0 because the current lint parser supports versions below
6.1. ESLint stays on 9 because Next's React/import/accessibility plugins do not
yet declare ESLint 10 compatibility; npm reports that ESLint 9 is out of support.
Upgrade these together once the Next lint dependency chain supports them.

```bash
cd /workspace/what-is-love
# If nvm is installed: nvm install && nvm use
npm ci
npm run dev
```

The development server listens on all interfaces, port 3000. On your own machine,
open `http://localhost:3000`. No Supabase credentials or external service are needed
to display the homepage. System fonts and local SVG artwork avoid font/CDN requests.
`next.config.ts` also permits `127.0.0.1` as a development origin for local hot
reload. For a future forwarded host, add only its specific hostname to
`allowedDevOrigins` if needed; do not allow every origin.

For a long-running cloud session, keep terminal output connected or launch with
logging so an orphaned terminal cannot cause write errors:

```bash
nohup npm run dev > /tmp/what-is-love-dev.log 2>&1 < /dev/null &
tail -n 20 /tmp/what-is-love-dev.log
```

Validate an existing instance before starting another; do not kill unrelated processes.

In this Codex cloud onboarding environment, the UI does not provide a web preview
for loopback addresses. Starting the server and requesting it from the shell verifies
the app, but does not create a public preview URL. If your Codex client provides a
port-forwarding/preview control, forward port 3000 through that control; otherwise
run the checkout locally using the commands above. Do not treat a cloud machine's
`localhost` URL as a link accessible from your browser.

The repository `.npmrc` puts npm's cache in `/tmp/what-is-love-npm-cache` because
the cloud home directory may be read-only. Removing the cache is safe; `npm ci`
restores dependencies using the lockfile. This setting is intended for Linux/macOS;
Windows users can override it with `npm ci --cache <writable-directory>`.

## Checks and production

```bash
npm run lint
npm run typecheck
npm test
npm run test:db # Requires Docker; runs against an isolated disposable PostgreSQL 17
npm run build
npm start
```

`npm test` runs 34 checks for environment validation, room status/code/nickname
validation, verified session recovery, RPC argument boundaries, and cookie/cache
handling. Auth transport in these unit tests uses test-only contract fixtures.
`npm run test:db` runs 28 checks against real PostgreSQL in a network-isolated,
ephemeral Docker container: migrations, RLS, privileges, concurrency, unique
membership, collision retries, and rollback. It never reads a live database URL.
No live Supabase project is contacted. See `docs/supabase.md` for coverage limits.
`npm start` serves the production build on port 3000. Stop the development server
before starting production on the same port. To use another port:
`npm run dev -- --port 3001` or `npm start -- --port 3001`.
`npm run typecheck` generates Next.js route declarations before checking types,
so it also works in a fresh checkout. Next's generated `next-env.d.ts` is ignored.

## Supabase preparation

Optional: copy `.env.example` to `.env.local` without overwriting an existing local
file. Replace the placeholders with the project's **URL** and **publishable key**
from Supabase's project settings, then restart the development server.

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
```

These `NEXT_PUBLIC_` values are intentionally public and included in browser builds.
Never put database passwords, service-role keys, Supabase secret keys, or future AI
API secrets in public variables. `.env.local` and other `.env.*` files are ignored;
only the placeholder `.env.example` is tracked. Public configuration must be present
at build time when a future browser feature uses it.

`src/lib/config/env.ts` validates configuration on demand. Its optional reader returns
`null` when both values are absent or still placeholders; client factories use the
required reader and throw a clear configuration error if a database-dependent
operation is attempted. Partial or malformed configuration also throws without
printing values. Only `sb_publishable_` keys are accepted. HTTPS origins are required
except for localhost development.

`src/lib/supabase/client.ts` creates a typed cookie-based browser singleton on demand.
`src/lib/supabase/server.ts` is guarded with `server-only` and prepares a per-request
client for future Route Handlers. Pass a mutable `Headers` object and attach it to
the returned `Response`; this preserves the SDK's non-cacheable auth headers. Use
this writable-cookie helper only before returning a handler response, not in a
read-only Server Component. No Server Action or HTTP mutation endpoint is exposed
in this phase. `src/proxy.ts` refreshes existing sessions using verified `getUser()`
and forwards updated cookies to both the request and response. It never signs up
homepage visitors. The homepage itself imports no Supabase client.

Review both migrations, in order: `20261011000000_room_foundation.sql`, then
`20261011010000_room_security_hardening.sql`, and
[Supabase setup and security](docs/supabase.md) before applying anything. Enable
Anonymous Sign-Ins in Supabase project settings before live Auth testing. Adding
credentials alone does not apply migrations or enable homepage room actions.
No storage buckets, realtime publication changes, or AI integrations are created.
Database-enforced create/join limits default to 5 attempts/10 minutes and 20/minute
per authenticated UUID. Private administrator configuration sets quotas of 3 retained
owned rooms, 10 memberships/user, and 20 members/room. RPC domain rejections return
an error_code; adapters treat them as failures. All clients share production Secure
cookies and private auth caching. Initial anonymous signup uses origin Web Locks,
with explicit retry after interrupted signup. See the linked guide for adjustments,
compatibility limits, timeouts, and retention policy; no automatic cleanup is added.

## Project structure

```text
src/
  app/                 App Router pages, root layout, global design tokens
  components/
    home/              Homepage artwork and presentation
    ui/                Reusable Button and Container
  features/
    auth/              Verified anonymous participant/session helpers
    rooms/             Room types, input validation, typed data access
  lib/
    config/            Site metadata, six dimension identifiers, environment validation
    supabase/          Typed clients, database types, cookie refresh transport
  proxy.ts             Next.js session refresh entry point
supabase/migrations/   Schema, RLS, and trusted create/join RPCs (not applied live)
tests/                 Unit tests and isolated PostgreSQL policy tests
docs/                  Architecture and Supabase review/application instructions
```

Visual identity is centralized in `src/app/globals.css`: colors, system typography,
base spacing (Tailwind's scale), and control sizing/radius. The initial design uses
no animation library. Decorative artwork is independent of application logic.

## Next phase

Review and approve both migrations first, apply them to a staging Supabase project,
enable anonymous Auth, and run the multi-client live checks in `docs/supabase.md`.
After those pass, build the create/join UI and waiting lobby, configure Auth abuse protection and
CAPTCHA before public use, and introduce room-scoped realtime membership. Keep
the existing actions disabled until their real workflows are available.
