# WHAT IS LOVE?

A collaborative transmedia storytelling experience about love and belonging.

Phase 0 provides the application foundation and a responsive homepage. Room creation,
joining, contributions, multiplayer, and AI are **not implemented**. Both homepage
actions are disabled and explicitly marked as coming in the next phase.

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
npm run build
npm start
```

`npm test` runs Node's built-in test runner against environment validation: missing
and placeholder configuration, partial configuration, valid origins, public-key
requirements, unsafe URLs, and local development URLs. No live database is contacted.
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

`src/lib/config/env.ts` validates configuration on demand and returns `null` when
both values are absent or still placeholders. Partial or malformed configuration
throws a descriptive error without printing values. Only `sb_publishable_` keys are
accepted. HTTPS origins are required except for localhost development.

`src/lib/supabase/client.ts` creates a cookie-based browser client on demand.
`src/lib/supabase/server.ts` is guarded with `server-only` and prepares a per-request
client for future Route Handlers / Server Actions that can write response cookies.
It is not intended for read-only Server Components. Neither utility is imported
by the homepage, and no database request is made in Phase 0. Before authentication
is implemented, add session refresh handling and server-side identity verification
following Supabase's current Next.js guidance. A browser session alone is not an
authorization check. Generated database types can be added after a schema exists.

No tables, migrations, storage buckets, RLS policies, auth flows, or AI integrations
have been created. Adding credentials alone does not enable room functionality.

## Project structure

```text
src/
  app/                 App Router pages, root layout, global design tokens
  components/
    home/              Homepage artwork and presentation
    ui/                Reusable Button and Container
  lib/
    config/            Site metadata, six dimension identifiers, environment validation
    supabase/          Lazy browser and server client utilities
tests/                 Configuration validation tests
docs/architecture.md   Feature boundaries and future implementation guidance
```

Visual identity is centralized in `src/app/globals.css`: colors, system typography,
base spacing (Tailwind's scale), and control sizing/radius. The initial design uses
no animation library. Decorative artwork is independent of application logic.

## Next phase

Implement real Robot Rooms: agree on the room/participant schema and membership
rules, create migrations and RLS policies, add participant identity and recovery,
then build validated create/join flows with unguessable room codes and realtime
membership. Test separate rooms for isolation and reconnect behavior before adding
contribution modules or AI. See `docs/architecture.md`.
