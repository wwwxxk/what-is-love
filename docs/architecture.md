# Phase 0 architecture

The homepage is a static Server Component. It renders site configuration and small
presentation components; it does not create a Supabase client. Missing credentials
must never prevent the initial homepage from building or rendering.

`src/app` owns routing and page composition. `src/components/ui` owns reusable
presentation. `src/lib/config` holds shared metadata and environment validation.
`src/lib/supabase` is the external-service boundary. Add domain code when a feature
exists, rather than creating empty service classes, placeholder APIs, or fake data.

Future features should live under `src/features/<feature>` with their own components,
types, validation, and domain operations. Route handlers and server actions remain
thin adapters that verify identity and delegate work. Shared code moves into `lib`
only when more than one real feature needs it. Domain operations must not depend on
styling or animation. Keep any future animation behavior in presentation components.

## Planned boundaries (not implemented)

| Feature | Responsibility |
| --- | --- |
| rooms | Create/join, room lifecycle, room-scoped authorization |
| participants | Identity, membership, session recovery |
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

Start Phase 1 with the room and participant model, including privacy, anonymous or
authenticated identity, invite-code rules, recovery, and room isolation. Add real
database migrations, generated types, and policy tests together. Implement cookie
session refresh and verified server-side identity before protected actions. Then
implement create/join, graceful error handling, reconnect behavior, and realtime
membership. Keep both homepage buttons disabled until those workflows exist.

No future feature directories or database objects are created in Phase 0.
