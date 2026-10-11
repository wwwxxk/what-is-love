# Application architecture — Phase 1C local implementation

The homepage is a static Server Component. It renders site configuration and small
presentation components; it does not create a Supabase client. Missing credentials
must never prevent the initial homepage from building or rendering.

The Phase 1A foundation adds `src/features/auth` and `src/features/rooms`.
Auth helpers restore verified identity or explicitly create
an anonymous session. Room adapters use typed, authenticated Supabase clients and
reviewed RPCs; they never write tables directly. The database is the authorization
boundary. Nicknames and invitation codes do not establish authenticated identity.

`src/proxy.ts` delegates existing-session refresh to `src/lib/supabase/proxy.ts`.
Cookie writes reach both downstream requests and browser responses, and auth
responses stay private/non-cacheable. Proxy is not an authorization gate; each
room operation verifies its user and RLS independently limits data access.

`src/app` owns routing and page composition. `src/components/ui` owns reusable
presentation. `src/lib/config` holds shared metadata and environment validation.
`src/lib/supabase` is the external-service boundary. Add domain code when a feature
exists, rather than creating empty service classes, placeholder APIs, or fake data.

Future features should live under `src/features/<feature>` with their own components,
types, validation, and domain operations. Route handlers and server actions remain
thin adapters that verify identity and delegate work. Shared code moves into `lib`
only when more than one real feature needs it. Domain operations must not depend on
styling or animation. Keep any future animation behavior in presentation components.

## Feature boundaries

| Feature | Responsibility |
| --- | --- |
| rooms | Create/join, authoritative snapshots, private member notifications, organizer start, waiting and Training Preparation |
| auth / participants | Anonymous identity/session helpers, membership schema, and explicit recovery UI implemented |
| tasks | Assignment and card drawing |
| contributions | Shared contribution contracts; separate who, what, when, where, how, feeling modules |
| gallery | Room-scoped memory display and media access |
| awakening | Collective readiness and awakening state |
| character | Robot Character Profile and persistent visual identity across camera angles |
| generation | Server-side AI requests and generated media; private credentials stay on the server |
| conversation | Shared room conversation and synchronization |
| endings | Final belonging votes and ending selection |

Rooms are created as needed; do not seed a fixed set of rooms. Every room-bound
record and storage operation will need an explicit authorization boundary. Enforce
membership through RLS and storage policies, not browser filtering alone. Treat
realtime updates as synchronized views of persisted state rather than the source
of truth. Resolve concurrent state transitions on the server/database.

The migrations and policy tests now define the initial room/participant model and
invitation rules. Database types currently mirror that migration manually; regenerate
them from Supabase in a separately authorized task. The development project has the
reviewed Phase 1A migrations and passed the minimal API smoke test. See `supabase.md`
for policy details and deployment checks. Phase 1C SQL remains undeployed; see
`phase-1c.md` for its controller, contracts, isolated tests, and approval boundaries.
Hosted browser/cookie checks remain pending.

The `/create`, `/join?code=…`, and `/rooms/[roomId]` routes use server-rendered public
shells and client-side authenticated operations. No room details enter server HTML
or metadata. Forms reuse validation, session helpers, and RPC adapters. Room snapshots
recheck identity and membership; session changes invalidate stale results. One
controller coalesces reads, compares decimal-string versions, subscribes to the
caller's membership-bound private Broadcast channel, and refreshes on subscription.
Notifications only invalidate; rendered data comes from RLS snapshots. Polling
repairs missed events every 15 seconds while visible. Reconnect, visibility, and
online events refresh; navigation releases only owned subscription leases.
QR encoding is local (`qrcode`); links never go to a third-party QR service.
See `phase-1b.md` for creation uncertainty and recovery behavior.

No contribution, AI, media, conversation, or voting feature directories are created.

## Admission and identity coordination

A second migration enforces per-Auth-user fixed-window request budgets and retained
room/member quotas using private administrator-only tables. Requests lock configuration,
then the actor counter, then the target room. Phase 1C start locks only the room and
does not subsequently acquire configuration/actor locks. Privileged membership
maintenance must lock affected rooms in UUID order before changing member rows.
Domain rejections return error_code so failed attempts remain counted after commit.
Adapters turn those outcomes into failures. Transactional faults/timeouts roll back.
RPC locks time out after 2 seconds; PostgREST RPC statements default to 5 seconds,
with an 8-second role ceiling and preservation of stricter existing limits.

All Supabase clients share production Secure/SameSite Lax cookie options and private
cache headers. Initial anonymous signup uses an origin Web Lock and a non-secret
interrupted-attempt marker. Existing sessions are verified again after waiting;
unsupported coordination fails closed for new signup, and interrupted signup needs
an explicit user retry. No lease expiry can permit a competing signup. Modern mobile
browsers use the same primitives over HTTPS. Room data is never statically cached.

Records are retained until approved administrator maintenance; finished rooms count
toward quotas. Organizer Auth deletion is restricted while referenced rooms exist.
There is no automatic cleanup or ownership transfer. See supabase.md for the exact
migration order, limits, session-loss behavior, and approved live connection procedure.
