# Phase 1C — local room synchronization and control

Checkpoint B implements application code against the corrected Checkpoint A drafts.
Neither Phase 1C migration has been applied to hosted Supabase during this task.
Phase 1A SQL and both Phase 1C drafts are unchanged. The approved Phase 1B commit
remains the branch baseline; no Git commit, push, or deployment is included.

## User flow

Create/join retains existing verified anonymous identity, invitation and recovery
behavior. `/rooms/[roomId]` now loads a single authorized snapshot. While waiting,
members appear from snapshots refreshed by private notifications, visible-page
polling or manual refresh. The mobile layout still puts members before invitations.

Only a member with organizer role whose verified identity matches `created_by` sees
**Start Training**. The native confirmation dialog warns that admission closes,
allows cancellation/Escape, and explains that starting alone is permitted. The
controller prevents duplicate submissions and never advances the UI optimistically.
The database remains the authority; client visibility is only a convenience.

An authoritative `task_assignment` snapshot renders **Training Preparation** for
every member. It preserves room code, nickname, role and member list and introduces
WHO, WHAT, WHEN, WHERE, HOW and FEELING. There are no assigned dimensions,
contribution records or pretend Continue transitions. Later reserved statuses show
a limited room-context message; their experiences are not implemented.

## Backend contracts and ownership

| Operation | Contract | Application behavior |
| --- | --- | --- |
| Snapshot | `get_robot_room_snapshot(p_room_id uuid)` → `room jsonb, participant_id uuid, members jsonb, room_version text, error_code text` | One MVCC snapshot under existing RLS; identity verified before and after; missing/unauthorized rooms hide all details |
| Start | `start_robot_room(p_room_id uuid)` → `room_id uuid, status room_status, started_at timestamptz, room_version text, already_started boolean, error_code text` | JWT-bound organizer/creator authorization in SQL; room lock serializes starts/joins; repeats return persisted state without another transition |
| Notification | Private `wil:room:<room UUID>:member:<own membership UUID>`, event `room_changed` | Own-member channel only; discard payload and refresh a snapshot; no client publish or Presence |

The adapters handle HTTP errors and non-null `error_code` even with HTTP 200.
They validate membership, UUIDs, statuses, timestamps and canonical nonnegative
decimal-string revisions up to PostgreSQL bigint max. Versions never pass through
a JavaScript number. Database types keep the column optional on legacy admission
reads, which remain compatible with Phase 1A; the lifecycle snapshot validator
requires it. No SQL signature, grants, policies or naming contract changed.

## Synchronization and recovery

`lifecycle.ts` owns verified RPC adapters. `synchronization.ts` is a reusable,
dependency-injected controller; `realtime.ts` adapts the existing singleton SDK;
`use-room-synchronization.ts` owns React and browser lifecycle listeners.

1. Restore identity with verified `getUser()`; never sign up during room recovery.
2. Read a snapshot and discover the caller's membership.
3. Bind the private membership topic, then refresh again after `SUBSCRIBED` to close
   the initial read/subscription gap.
4. Coalesce notification bursts into one active refresh plus a dirty follow-up.
   Treat all events as invalidation, even forged or stale payloads.
5. Ignore smaller revisions, responses from older identity generations, cancelled
   work and callbacks from released channels. Membership replacement rebinds.
6. Recheck on reconnect, online and visible-tab recovery. Visible pages also poll
   every 15 seconds, repairing missed events. Background event reads/polls pause;
   an already active request can finish. A first room read still verifies access.
7. Bound read/write waits to 20 seconds. On verification failure hide personalized
   content and release the channel; retry uses the existing identity and a new
   authorized lease. Realtime failure alone falls back to HTTP polling.
8. After every start outcome, including timeout or a lost response, refresh state.
   Never automatically retry the write. An explicit later retry is safe because
   the SQL operation is idempotent. A timeout cannot cancel an already committed
   server mutation; snapshots and polling resolve that uncertainty.
9. On navigation/unmount abort outstanding work and cancel timers/listeners. Channel
   leases are reference counted because the SDK deduplicates topics. Release only
   owned channels, await previous removal before reuse, and never take over an
   unrelated public/unowned channel or call `removeAllChannels()`.

Cookie security and origin Web Lock initial-signup coordination are unchanged.
Cookie loss cannot recover an organizer identity across devices or silently create
a replacement. Missing identity and revoked membership show safe recovery guidance.
Server HTML and metadata contain no private room data. QR encoding stays local.

## Reproducible isolated validation

```bash
npm run lint
npm run typecheck
npm test
npm run test:db
npm run test:db:phase1c
npm run test:browser:phase1c
```

Node 24 and frozen npm dependencies are used. The database suites require Docker
and the cached PostgreSQL 17 image pinned in the harness. Phase 1C uses `--pull=never`,
`--network none`, ephemeral tmpfs storage, no published ports or project mount, and
`docker exec` only. Readiness queries the actual fixture database. Harness outputs
are under `/tmp` and the disposable container is removed even after failures.
Platform Auth/Realtime objects are explicit SQL fixtures, not a live Supabase service.

Coverage includes 28 Phase 1A checks; 31 Phase 1C checks plus four deployment guards;
69 unit checks; 12 Phase 1B browser groups plus five Phase 1C browser groups. SQL
checks cover legacy-row migration, organizer-alone and idempotent/concurrent starts,
join/start races, RLS and ACLs, versions, rollback, unrelated-topic compatibility,
cross-member/outsider/revocation denial, publishing denial and hostile/null claims.
Controller tests cover timeouts, stale reads, missed/duplicate events, identity
changes, membership replacement, hidden tabs, owned cleanup and uncertain writes.

The browser runner builds the real production application with a loopback-only fake
public configuration, runs the real SDK, and mocks Auth, HTTP RPCs and Phoenix
WebSocket messages. It rejects non-loopback browser attempts. Screenshots cover
organizer/participant lobbies, start confirmation and organizer/participant Training
Preparation at 390px and 1440px. Production builds embed that fixture configuration;
rebuild with approved intended public configuration before any deployment.

## What remains unverified and approval needed

PostgreSQL policy checks and browser protocol mocks **do not establish hosted
WebSocket authorization or delivery security**. A complete isolated Supabase stack
is not available. Actual hosted `realtime.send`, role inheritance/ACLs, service
authorization/revocation timing, fan-out delivery, reconnect/token refresh and mobile
Safari behavior still need approved integration tests. TLS certificate trust must
be verified without bypassing errors. Per-room notification fan-out should be
observed under realistic hosted traffic before public use.

The room route now requires Phase 1C RPCs; deploying the application before the SQL
would produce the safe load-error screen. Backend and application deployment must
be coordinated. Historical Phase 1A schema migration history must not be repaired
again or either baseline migration reapplied.

Separate explicit approval is required to:

1. Reconfirm hosted read-only prerequisites, then apply exactly
   `20261011020000_room_lifecycle.sql` followed by
   `20261011030000_room_realtime.sql` to project `flsawwqcegjripjcqxqh`.
2. Record the newly applied versions in migration history using a separately
   approved supported reconciliation procedure if SQL Editor deployment is chosen.
3. Run a bounded hosted test plan with agreed counts/markers for anonymous Auth
   users, rooms, memberships and request-budget records; include private WebSocket
   subscription, isolation, publishing, revocation, delivery and reconnect checks.
   Data cleanup and privileged changes require their own explicit scope.

Git commit/push and deployment also require approval. This local task authorizes
none of those actions and created no live records.

## File inventory

Modified application/configuration files: `package.json`,
`src/app/rooms/[roomId]/page.tsx`, `src/components/rooms/waiting-lobby.tsx`,
`src/lib/supabase/database.types.ts`.

New application files: `src/features/rooms/lifecycle.ts`, `synchronization.ts`,
`realtime.ts`, `use-room-synchronization.ts`,
`src/components/rooms/start-confirmation.tsx`, `training-preparation.tsx`.

Tests: updated `tests/browser/phase1b.py`; added `tests/browser/phase1c.py`,
`tests/database/phase1c.py`, `tests/database/phase1c-platform.sql`,
`tests/room-lifecycle.test.mjs`. Documentation: updated `README.md` and
`docs/architecture.md`, added this guide. The two existing untracked Phase 1C SQL
drafts remain untouched. Dependencies and lockfile are unchanged.
