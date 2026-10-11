# Phase 1B — participant admission and waiting lobby

The UI lives on the local `phase-1b-create-join-ui` branch, based on the approved
Phase 1A commit. No new schema, role grants, RPC signatures, Realtime publication,
or migration-history changes are required. Nothing is automatically deployed.

## Routes and data boundary

- `/`: original responsive welcome design; actions link to the two flows.
- `/create`: nickname validation, explicit anonymous session establishment/reuse,
  the existing `createRoom` adapter, confirmed lobby navigation, and room recovery.
- `/join`: nickname and invitation-code entry. `/join?code=…` prefills an invitation;
  the existing normalizer accepts lowercase and hyphens. The existing `joinRoom`
  adapter preserves a returning participant's original membership, nickname, and role.
- `/rooms/[roomId]`: verified-session, member-only lobby. It shows the invitation,
  caller nickname/role, ordered membership list, count, local QR code and copy link.
  It never signs up visitors or joins them merely because the route was opened.

Personal details are fetched in the client under RLS. Server HTML/metadata contain
only public page shells. Cookie-bearing requests retain the Phase 1A private/no-store
proxy headers. No public room directory or direct table mutation endpoint exists.
Lobby polling checks every 15 seconds while visible, skips overlapping cycles, and
offers manual refresh. Auth identity changes invalidate pending results and hide old
data. This is polling, not Realtime. No organizer start/phase button is present.
On mobile, the member list appears before the role-aware waiting message and the
invitation panel. The QR code is an initially collapsed, keyboard-accessible native
disclosure; the 12-character code, copy action and invitation link stay available
without expanding it. Desktop keeps the two-column invitation/membership layout.
The create page explains that the shared room is the first step toward the robot.

## Safe creation and identity recovery

A synchronous submission guard and disabled controls prevent duplicate form submits.
Before dispatching a creation RPC, the browser saves a non-secret per-user attempt
marker in localStorage. Unavailable storage prevents dispatch. A 20-second UI timeout,
network failure, reload, or ambiguous response retains the marker and blocks another
creation attempt. It does not retry automatically. Confirmed domain rejections clear
the marker and allow an intentional retry. The browser client disables REST retries.

If creation succeeds but detail fetching fails, the adapter retains the confirmed
room UUID; the UI offers its waiting lobby. Late successful replies also retain that
UUID. Opening that authorized lobby acknowledges the confirmed marker. Otherwise,
“Return to my room” makes verified, owner-filtered SELECTs under RLS so users
can return to an existing room without sending a second creation RPC.

An unknown outcome with no received room UUID cannot be conclusively reconciled
by this architecture: the RPC has no idempotency key or attempt lookup. Even if a
room is recovered through the list, an unconfirmed marker stays blocked. If no room
appears, wait/check again or seek support; do not delete the marker and blindly retry.
Independent intentional submissions from different tabs/devices are not claimed to
be globally idempotent. An idempotent creation contract needs separate database review.

Session helpers continue using the existing Web Lock/IndexedDB coordination. Errors
never silently replace an identity. After a failed/interrupted or lost signup,
explicit retry requires acknowledging the recovery limitations; it sets only the
existing helper's retry flag and still reuses any verified valid session. An Auth
outage cannot be bypassed with that flag. A nickname/code cannot recover organizer
ownership; another device or lost refresh credentials may require a new participant.
There is no automatic sign-out, cleanup, ownership transfer, or session reset.

## Validation and preview

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:db
npm run test:browser
```

Browser checks require Python Playwright and Chromium. The script builds with
fixture-only URL/key values, starts its own loopback servers, blocks other browser
destinations, and uses fake Auth/REST responses. It exercises the real rendered UI,
SDK cookie restoration and cross-tab primitives but does not verify hosted JWTs,
RLS, CAPTCHA, or physical mobile Safari. PostgreSQL policy tests remain the separate
real-database authorization checks. Screenshots/results/logs are saved under `/tmp`.
No production users, rooms, sessions, or counters are created by these tests.

For review, `npm run dev` uses current environment configuration. Open localhost
port 3000 on your own machine or use a supported cloud port-forwarding control.
Do not submit forms against live Supabase without approval for test records.
`npm run test:browser` leaves a fixture production build; run `npm run build` with
the intended public variables before `npm start`. Do not print or commit variable
values. The homepage and form shells work without configured Supabase; submission
then reports a connection/session failure safely.

## Remaining work

Live Chromium access in this cloud environment previously failed proxy CA trust.
Do not use ignore-certificate flags or weaken TLS. Hosted browser tests and physical
mobile checks require supported trust/network access and explicit test-data approval.
The minimal Phase 1A API smoke passed; it does not verify the Phase 1B browser UI.
Production cookies still require HTTPS. CAPTCHA-enabled signup fails safely when no
challenge token is available; provider-specific challenge UI remains to be designed
before public use, along with Auth abuse settings. No paid service is introduced.

Phase 1C should review room-scoped Realtime subscriptions/reconnection and organizer
phase-transition RPCs with concurrency and authorization tests. Also reconcile manual
migration history in a separately approved task before future migrations. Task cards,
contributions, AI, awakening, conversation, voting, and cinematic effects remain later work.
