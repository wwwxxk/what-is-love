# WHAT IS LOVE?

A collaborative transmedia storytelling experience about love and belonging.

Phase 1B implements **Welcome → Create / Join → Waiting Lobby** using the Phase 1A
anonymous Auth, RLS, and room RPC foundation. Phase 1C adds local implementation of
private membership-bound room synchronization and organizer-controlled
**Waiting Lobby → Training Preparation**. The two Phase 1C SQL drafts have been
tested in isolated PostgreSQL but have **not been deployed**. The application room
screen now requires their snapshot/start RPCs. Contributions, assignments, and AI
are outside this phase. See [Phase 1C](docs/phase-1c.md) before hosted testing.

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
npm run test:db:phase1c # Baseline plus proposed lifecycle/Realtime SQL; no network
npm run test:browser # Requires Python Playwright and Chromium; local fixtures only
npm run test:browser:phase1c # Phase 1B regressions plus mocked private WebSocket flows
npm run build
npm start
```

`npm test` runs 69 checks for environment validation, room status/code/nickname
validation, verified session recovery, RPC argument boundaries, cookie/cache handling,
creation uncertainty, lobby access, lifecycle RPCs, and synchronization/recovery.
Auth transport uses test-only fixtures.
`npm run test:db` runs 28 checks against real PostgreSQL in a network-isolated,
ephemeral Docker container: migrations, RLS, privileges, concurrency, unique
membership, collision retries, and rollback. It never reads a live database URL.
No live Supabase project is contacted. See `docs/supabase.md` for coverage limits.
`npm run test:browser` builds with a local fixture URL/key and starts its own servers
on dynamically selected loopback ports. It blocks non-loopback browser requests;
outputs go to `/tmp`.
It requires Python Playwright and Chromium, already available in this cloud runtime.
Because that build embeds fixture configuration, rebuild with your intended public
configuration before using `npm start` afterward. `npm run dev` reads the current
environment independently. See [Phase 1B](docs/phase-1b.md) for routes and limitations.
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
at build time for the browser room flows.

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
credentials alone does not apply migrations. Do not reapply the already deployed
migrations to the same project. Their migration history has been reconciled according
to the project's approved Dashboard inspection. Phase 1C drafts require separate
approval and hosted prerequisite verification; do not execute them during setup.
No storage buckets, Postgres Changes publications, or AI integrations are created.
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
    rooms/             Create/join forms, recovery, waiting, and Training Preparation
    ui/                Reusable Button and Container
  features/
    auth/              Verified anonymous participant/session helpers
    rooms/             Room validation, typed RPCs, synchronization controller/transport
  lib/
    config/            Site metadata, six dimension identifiers, environment validation
    supabase/          Typed clients, database types, cookie refresh transport
  proxy.ts             Next.js session refresh entry point
supabase/migrations/   Deployed Phase 1A and undeployed Phase 1C SQL drafts
tests/                 Unit, isolated PostgreSQL, and local fixture browser tests
docs/                  Architecture and Supabase review/application instructions
```

Visual identity is centralized in `src/app/globals.css`: colors, system typography,
base spacing (Tailwind's scale), and control sizing/radius. The initial design uses
no animation library. Decorative artwork is independent of application logic.

## Next phase

Review Phase 1C locally, then separately authorize hosted migrations and bounded
integration tests. Resolve hosted browser certificate trust and configure Auth abuse
protection and a supported CAPTCHA flow before public use. Keep later storytelling
features outside the room admission/lobby foundation.
