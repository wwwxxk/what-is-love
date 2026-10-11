# Supabase Phase 1A — security and connection guide

The reviewed Phase 1A migrations were applied to the verified development project
through the Dashboard SQL Editor, Anonymous Sign-Ins were enabled, and the approved
minimal API smoke test passed. Migration history has not been reconciled. Phase 1B
adds create/join/lobby UI without database changes. Further live tests, configuration,
migrations, deployment, commits, pushes, or pull requests require approval.

## Migrations: exact order

1. `supabase/migrations/20261011000000_room_foundation.sql`
2. `supabase/migrations/20261011010000_room_security_hardening.sql`

Run each complete file once, in this order. Both use transactions. The first
creates new objects and deliberately fails on name conflicts. The second replaces
the two RPC signatures in a transaction, preserving their exact names/arguments
and strict grants while adding nullable `error_code` to the result. There is no
unprotected overload. Because the project is currently unmigrated, apply both
before permitting client traffic. Do not deploy these clients with only migration 1.

## Authorization, constraints, and exposure

`public.rooms` stores UUIDs, a unique 12-character invitation code, one of nine
room statuses, creator UUID, and timestamps. `public.room_participants` stores
room/user UUIDs, nickname, organizer/participant role, and timestamps.

Unique `(room_id, auth_user_id)` prevents duplicate memberships. A partial unique
index permits at most one organizer. Nicknames are trimmed, 1–40 Unicode characters,
without control characters. Foreign keys and timestamp/status checks remain intact.

RLS on both public tables permits authenticated users to read only rooms to which
they belong and the participants of those rooms. All direct mutations are denied,
even for organizers. There is no status change, nickname change, or ownership
transfer API in Phase 1A. Anonymous Supabase sign-ins use the `authenticated` role;
the unauthenticated `anon` role has no table or RPC access. Existing registered
users are also supported; anonymous-only authorization is not imposed.

Both RPCs take identity from `auth.uid()`, never caller IDs or editable metadata.
Creation inserts the room and organizer atomically. Joining inserts only the
caller with role `participant`. New participants can join only `waiting` rooms.
Existing members recover their same UUID, nickname, and role in every phase.
An existing membership can recover even if a quota is subsequently lowered, but
all rejoin RPCs still count against the joining rate limit. Ordinary member reads
and session restoration do not consume admission budgets.

Invitation codes contain 60 random bits, exclude I/O/0/1, and accept lowercase or
grouping hyphens. Codes authorize an invitation request after authentication;
they cannot authenticate a user or recover an organizer. Unknown, malformed,
closed, and full invitations return the same `room_unavailable` result. Membership
quota rejection depends only on the caller's count and returns no room metadata.
Creation retries code collisions eight times and fails without orphan records.

Three SECURITY DEFINER functions have empty search paths and qualified application
objects: the two public RPCs and `room_private.is_room_member(uuid)`. The membership
helper avoids recursive RLS and uses the JWT UUID. Their owner must be a trusted
migration role, normally `postgres`, capable of bypassing membership RLS. Retest
before changing ownership or FORCE RLS. The private rate helper is SECURITY INVOKER
and executable only by the trusted RPC owner. Trigger/code helpers remain private.

Automatic RLS can remain enabled. Disabled automatic exposure/default grants can
remain disabled: migrations supply the minimum explicit table/function privileges,
including `USAGE` on `public` and the private helper schema for `authenticated`.
Private tables also enable RLS with no API policies or grants. Keep **Data API enabled**,
**public exposed**, and **room_private unexposed** in API settings. Schema USAGE
permits name resolution; it does not expose a schema in the API. Do not fix access
errors by granting all privileges, permitting direct writes, or restoring automatic
exposure. No Realtime publication or storage configuration is needed.

Disabling table exposure does not automatically revoke the PostgreSQL global PUBLIC
EXECUTE default for functions. Both migrations explicitly revoke it on their functions.
Enabling anonymous Auth also gives these users the authenticated role on unrelated
project objects; review existing policies in the same project separately.

## Database-enforced limits and concurrency

No external service or browser throttle enforces these controls. Limits are stored
in the private singleton table `room_private.room_limits` and can be changed only
by a trusted database administrator.

| Setting | Default | Meaning |
| --- | --- | --- |
| create_requests | 5 | Create attempts per user/window |
| create_window_seconds | 600 | Ten-minute fixed window, anchored to its first attempt |
| join_requests | 20 | Join attempts per user/window |
| join_window_seconds | 60 | One-minute fixed window, anchored to its first attempt |
| owned_rooms | 3 | Retained rooms created by one user |
| memberships_per_user | 10 | Retained memberships, including organizer memberships |
| members_per_room | 20 | Total memberships in a room, including the organizer |

Quotas count all retained records, including finished rooms; they are not online-user
counts. Existing records are not deleted if limits are lowered. Requests beyond a
rate limit are rejected until the window expires. Fixed windows allow a boundary
burst; they are not a sliding-window limiter. Creation and joining have independent
budgets. Invalid nickname/code, unknown/closed/full invitation, quota rejection,
and code-allocation exhaustion consume allowed attempts.

The private budget table has one bounded counter row per Auth UUID. RPCs first take
a shared configuration lock, then an exclusive actor-budget row lock. Joining then
locks its target room. This order serializes creation/joining for one user and
admissions by different users to one room. Quota checks and successful writes occur
in that same transaction. Future write RPCs must preserve this lock order and quota
accounting. Privileged maintenance must coordinate separately; API users cannot
modify counters, limits, or membership records.

**Important result contract:** a denied domain operation returns one row with null
room/participant UUIDs and a non-null `error_code`, rather than raising an exception.
This commits the counted attempt. PostgREST therefore returns HTTP 200 for these
domain rejections; consumers must inspect `error_code`. Typed adapters convert them
to safe `RoomOperationError` failures and never read or return fake memberships.
Successful results have both UUIDs and `error_code: null`.

Authentication/SQL faults, cancellations, and lock/statement timeouts remain genuine
errors and roll back the entire transaction, including counters. PostgreSQL cannot
durably count a rolled-back transaction without a separate trusted transaction.
Those operations are bounded by timeouts. Auth/gateway failures before RPC execution
are outside these budgets. Callers may also create multiple anonymous identities;
per-user quotas cannot prevent that. Configure Auth abuse limits and CAPTCHA before
public use. No IP or global quota is claimed.

After approval, an administrator can adjust limits with narrowly scoped SQL:

```sql
-- Example only; do not run without approval.
update room_private.room_limits
set create_requests = 5, create_window_seconds = 600,
    join_requests = 20, join_window_seconds = 60,
    owned_rooms = 3, memberships_per_user = 10, members_per_room = 20
where singleton = true;
```

Constraints require positive bounded values; zero is not a supported disable switch.
Updates become coherent for the next transaction and may wait up to the in-flight
RPC duration. Lowering windows/limits applies to existing counters immediately;
changing a window can make old windows expire. Treat changes as reviewed configuration.

## Lock and statement timeouts

The RPCs and budget helper use a **2-second lock timeout**. Both RPCs declare a
**5-second statement timeout**, which PostgREST honors before query execution.
The migration also caps `authenticated` role statements at **8 seconds**, retaining
an existing tighter role timeout and reducing RPC timeouts to that tighter value.
This role setting affects other authenticated Data API operations in the project;
review their workloads before deployment. PostgREST configuration reload is notified
in the same committed migration.

Function SET statement_timeout alone does not restart an already-running SQL query's
timer. Direct SQL callers must configure a session/transaction timeout before the
statement. SET ROLE alone does not load role defaults. The test suite checks actual
query cancellation with a timeout set before a query and actual RPC lock contention;
hosted PostgREST timing must also be verified after deployment approval.

To adjust timeouts later, explicitly review both RPC settings and the shared role
setting, retain stricter project limits, and notify PostgREST to reload configuration.
A timeout is a failure, not a successful membership. Retry transient contention with
bounded backoff; do not blindly retry creation after uncertain transport failures,
since creation is not idempotent and may already have committed.

## Cookies and anonymous identity

Browser, server, and proxy clients use `getSessionCookieOptions`: path `/`, SameSite
Lax, JavaScript-readable cookies required by the browser SDK, and Secure in production.
Production must use HTTPS. Development leaves Secure disabled for local HTTP; do not
expose a development server publicly as a production deployment. Host-only cookies
are preserved. SDK lifetimes and chunking remain intact.

The proxy refreshes only existing session cookies using verified `getUser()`. It
forwards all cookie changes to the request and response, and forces private/no-store
cache headers even if a cookie callback supplies public cache headers. The server
client is request-scoped and server-only; future Route Handlers must attach its
mutable response headers to the actual returned Response. Do not use this writable
adapter in Server Components. Personal data must never be statically rendered or
cached across users. The public homepage contains no personal data and
makes no Auth request without an existing cookie.

`ensureAnonymousParticipant` first verifies any existing session, then coordinates
initial signup through an exclusive **origin-scoped Web Lock**, rechecking cookies
inside the lock. Calls on the same client also share a promise. Modern mobile Safari
and Chrome support Web Locks over HTTPS. A 15-second lock acquisition timeout fails
closed; it never steals a running tab's lock. Browsers lacking Web Locks or usable
IndexedDB can reuse an existing verified session but cannot create a new one.
There is no unsafe time-based lease or unlocked fallback.

A non-secret IndexedDB marker records an in-flight initial signup. It contains
only `pending` or `complete`, no identity, password, or token. Failed/interrupted signup leaves it
present, preventing another tab from silently creating a replacement identity.
Successful signup marks it complete. Cookie recovery inside the lock also marks
it complete. A transactional marker prevents stale cookie caches from allowing a
second signup; completed signup waits up to three seconds for cross-tab cookie
visibility. Missing cookies after completed signup require explicit retry too. The
future retry UI must explicitly explain identity loss and invoke
`ensureAnonymousParticipant(client, { retryInterruptedSignIn: true, captchaToken })`
only after a deliberate user retry. Never automatically set that flag. If a failed
network response created an account but its session was never received, the anonymous
Auth API offers no idempotent recovery; the explicit retry can leave an orphan account.

Auth errors or outages never trigger replacement signup. Missing cookies/refresh
tokens, sign-out, another browser, or another device can lose an anonymous identity.
With valid refresh credentials, access-token refresh preserves the same UUID. Neither
nickname nor invitation code recovers a lost identity; a new identity may join a
waiting room as a separate participant but cannot reclaim organizer privileges.
Access JWTs can remain valid until expiry after refresh-token revocation/sign-out.
Immediate revocation and cross-device recovery require separately designed controls.

## Current retention and organizer-deletion policy

No automatic cleanup, cron job, TTL, or cleanup UI is implemented. Rooms, memberships,
and budget rows remain until an approved administrator maintenance operation.
Finished rooms continue consuming quotas. Signing out does not delete database rows.

Deleting an organizer's Auth account is **blocked while any room references it**
through `rooms.created_by ON DELETE RESTRICT`. Do not bypass or weaken this constraint.
Current supported administrator procedure: review/export or back up the affected
rooms, deliberately delete the organizer's rooms (which cascades memberships), then
delete the Auth account. Do not delete shared rooms merely because a session expired.
There is no supported ownership-transfer workflow yet. Deleting an ordinary
participant Auth account cascades that user's memberships and budget row. Room
removal does not invalidate a still-existing user session. All live maintenance
requires separate approval; no cleanup operation is run by installation/startup.

## Step-by-step live connection: only after approval

1. Confirm the exact project name/reference and environment. Prefer staging. Review
   existing objects, migration history, unrelated authenticated policies, event
   triggers, and current role timeouts. Take an appropriate backup. Resolve conflicts
   explicitly; never replace existing tables blindly.
2. Authenticate the Supabase CLI using secure prompts/protected settings. In this
   checkout, run `supabase init` only if `supabase/config.toml` is absent, then
   `supabase link --project-ref <verified-project-ref>`, `supabase migration list`,
   and `supabase db push --dry-run`. Confirm the pending files are exactly the two
   above in order. Apply with `supabase db push` only after approval. Alternatively,
   run each complete file once through the verified project's SQL Editor, in order;
   reconcile CLI history before later CLI pushes. Never put credentials in chat,
   command-line arguments/history, repository files, logs, or build output.
3. Inspect the resulting RLS, grants, function ownership, private configuration,
   and timeouts with the read-only queries below. Keep automatic RLS enabled and
   automatic exposure disabled. In API/Data API settings, enable the Data API, expose
   public, and do not expose room_private. Do not change Realtime publication.
4. In Authentication → Sign In / Providers, enable **Anonymous Sign-Ins**. Check
   signup restrictions and Auth rate limits. Before public use configure supported
   CAPTCHA, such as free Cloudflare Turnstile; the helper accepts tokens but CAPTCHA
   UI is outside Phase 1A. No paid service is required or integrated.
5. In Codex cloud **Environment settings → Variables**, securely enter the matching
   project's `NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co` and
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...`. Both are intentionally
   public browser configuration. Never use sb_secret_, a service-role key, a database
   password, or a personal access token there. For local development, use ignored
   `.env.local` without overwriting existing settings. Preserve `.env.example` placeholders.
6. If outbound networking is restricted, add only the exact project hostname while
   preserving existing rules. Restart development services and rebuild production:
   NEXT_PUBLIC values are embedded at build time. Serve production over HTTPS.
7. Regenerate types with `supabase gen types typescript --linked --schema public`
   into a temporary file and review against both migrations; preserve the exported
   Room, RoomParticipant, and RoomRpcResult aliases used by adapters. These types
   currently mirror SQL manually and are not claimed to be generated from a live DB.
8. Run the hosted checklist below with an SDK harness/PostgREST and independent
   browser profiles only after approval. Phase 1B now provides create/join/lobby UI;
   connecting settings alone does not verify hosted workflows. See `phase-1b.md`.

Read-only verification after approved application:

```sql
select has_schema_privilege('authenticated', 'public', 'usage') as public_usage;
select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity,
       pg_get_userbyid(c.relowner) as owner, c.relacl
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where (n.nspname='public' and c.relname in ('rooms','room_participants'))
   or (n.nspname='room_private' and c.relkind='r');
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies where schemaname in ('public','room_private');
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
       pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig, p.proacl
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='room_private' or
      (n.nspname='public' and p.proname in ('create_robot_room','join_robot_room'));
select rolname, rolbypassrls, rolconfig from pg_roles
where rolname in ('postgres','authenticated','anon');
select * from room_private.room_limits;
```

Expected API privileges: authenticated SELECT on the two public tables and EXECUTE
on the two RPCs and membership helper only; no table writes, no access to private
configuration/counters, no generator/limiter/trigger execution. The unauthenticated
anon role has no table or RPC privileges. Owner/admin access is intentionally privileged.
Schema exposure must be checked in dashboard settings, not inferred from SQL grants.

## Hosted integration checklist

- Three separate profiles A/B/C receive distinct Auth UUIDs. Four tabs in one profile
  perform simultaneous initial signup and receive one UUID. Refresh preserves it.
- A creates an organizer room; B joins as participant. A/B read only their rooms.
  C gets no rows by room UUID or code until legitimately joining.
- Key-only calls, forged/expired JWTs, direct table writes, identity replacement,
  nickname changes, self-promotion, and arbitrary status changes are denied.
- Repeated/concurrent joins return the same membership; separate rooms stay isolated.
  In staging, closed/full rooms reject new users while existing members recover.
- Exercise rate limits directly through PostgREST, including malformed, unknown,
  closed-room and invalid-nickname attempts. Confirm rejected counters persist and
  domain results are not mistaken for successful HTTP 200 responses.
- Verify owned-room, total-membership, and per-room quotas; concurrent create/join
  calls cannot exceed them. Restore approved defaults after staging experiments.
- Verify lock contention and real PostgREST statement cancellation. Confirm tighter
  project timeouts are preserved. Do not add sleeping functions to production.
- Inspect Secure/SameSite cookies and private/no-store responses over deployment HTTPS.
  Confirm no auth tokens or private values appear in logs or caches.
- Test interrupted signup across tabs, explicit retry, valid cookie recovery, storage
  denial/unsupported browsers, mobile Safari/Chrome, expired refresh credentials, and
  switching devices. Test Auth outages without silent replacement accounts.
- Verify sign-out/revocation with the configured JWT lifetime; do not expect immediate
  access-token invalidation. Test organizer deletion restrictions in staging only.

## Local evidence and remaining limitations

`npm test`: 34 unit checks including cookie policy, coordinated sessions, explicit
retry, safe RPC rejection handling, validation, and argument boundaries.
`npm run test:db`: 28 real PostgreSQL 17 checks including both migrations, modeled
automatic RLS/disabled grants, actual database readiness, constraints, role execution,
concurrent quotas/joins, persisted failed attempts, collisions, rollback, and timeouts.
It uses Docker with no ports, no network, and a disposable tmpfs database, plus
Auth UID/role fixtures. The official image is pinned to digest
`sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826`.
No live URL or credentials are used. These checks do not verify hosted JWT/Auth,
PostgREST timeout loading, actual refresh-token rotation, or deployment cache behavior.

Local Chromium checks exercise real Web Locks, shared cookies, page reload, and
cross-tab failure markers with explicit test-only Auth transport fixtures on desktop
and mobile emulation; they do not prove physical mobile Safari or hosted Auth behavior.

Per-user limits do not prevent distributed requests/new-account abuse, nor count
rolled-back requests durably. Fixed windows allow boundary bursts. Creation is not
idempotent across uncertain responses. Web Locks/storage requirements exclude some
older/restricted browsers for initial signup. Session tokens remain XSS-sensitive.
Invite rotation/expiry, immediate JWT revocation, ownership transfer, lifecycle APIs,
automatic retention, Realtime, media, AI, and cross-device identity recovery remain
outside Phase 1A. Do not weaken authorization to work around these limitations.
