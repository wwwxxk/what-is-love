"""Phase 1B browser tests against a local contract fixture, never live Supabase.

Requires Python Playwright and Chromium. Runs a production build with overridden
public configuration, starts its own servers, and rejects non-loopback requests.
Fixtures exercise UI behavior, not hosted JWT validation or database RLS.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from urllib.request import ProxyHandler, build_opener
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


APP_PORT, API_PORT = free_port(), free_port()
while API_PORT == APP_PORT:
    API_PORT = free_port()
APP = f"http://127.0.0.1:{APP_PORT}"
API = f"http://127.0.0.1:{API_PORT}"
CODE = "ABCDEFGHJKLM"
ROOM_ID = "00000000-0000-4000-8000-000000000010"
ARTIFACTS = Path(tempfile.mkdtemp(prefix="what-is-love-phase1b-"))
STATE = {}


def reset(mode="normal", seed=False):
    STATE.clear()
    STATE.update(mode=mode, users={}, room=None, members=[], signup=0, creates=0,
                 joins=0, reads=0, delayed_reads=0, snapshots=0, starts=0)
    if seed:
        user = make_user()
        create_fixture_room(user["id"], "River")


def make_user():
    user = {"id": str(uuid.uuid4()), "aud": "authenticated", "role": "authenticated",
            "is_anonymous": True, "app_metadata": {"provider": "anonymous", "providers": ["anonymous"]},
            "user_metadata": {}, "created_at": "2026-10-11T00:00:00Z"}
    STATE["users"][user["id"]] = user
    return user


def encode(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def session(user):
    # Generated fixture token; no real key, signature, or credential is used.
    token = ".".join([encode({"alg": "HS256", "typ": "JWT"}),
                      encode({"sub": user["id"], "aud": "authenticated", "role": "authenticated",
                              "exp": int(time.time()) + 3600, "iat": int(time.time())}),
                      "fixture-signature"])
    return {"access_token": token, "refresh_token": f"fixture-{user['id']}",
            "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 3600, "user": user}


def create_fixture_room(user_id, nickname):
    instant = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    STATE["room"] = {"id": ROOM_ID, "join_code": CODE, "status": "waiting", "created_by": user_id,
                     "created_at": instant, "updated_at": instant, "started_at": None, "room_version": "1"}
    member = {"id": str(uuid.uuid4()), "room_id": ROOM_ID, "auth_user_id": user_id,
              "nickname": nickname, "role": "organizer", "joined_at": instant, "updated_at": instant}
    STATE["members"].append(member)
    return member


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, status=200):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", APP)
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Cache-Control", "private, no-store")
        self.end_headers()
        self.wfile.write(payload)

    def user(self):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        try:
            payload = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
            return STATE["users"].get(payload["sub"])
        except (ValueError, IndexError, KeyError):
            return None

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")

    def do_OPTIONS(self):
        self.reply({})

    def do_GET(self):
        path = urlsplit(self.path)
        user = self.user()
        if path.path == "/auth/v1/user":
            if STATE["mode"] == "user_read_failure":
                return self.reply({"code": "unexpected_failure", "msg": "Fixture verification unavailable"}, 503)
            return self.reply(user if user else {"code": "bad_jwt", "msg": "Fixture session unavailable"}, 200 if user else 401)
        if path.path == "/rest/v1/rooms" or path.path == "/rest/v1/room_participants":
            STATE["reads"] += 1
            if STATE["mode"] == "read_failure" and STATE["delayed_reads"] == 0:
                STATE["delayed_reads"] += 1
                return self.reply({"code": "fixture_unavailable", "message": "Fixture read failed"}, 503)
            authorized = user and any(m["auth_user_id"] == user["id"] for m in STATE["members"])
            rows = ([STATE["room"]] if STATE["room"] else []) if path.path.endswith("/rooms") else STATE["members"]
            rows = rows if authorized else []
            for field, values in parse_qs(path.query).items():
                if values[0].startswith("eq."):
                    rows = [row for row in rows if str(row.get(field)) == values[0][3:]]
            if "application/vnd.pgrst.object+json" in self.headers.get("Accept", ""):
                if len(rows) != 1:
                    return self.reply({"code": "PGRST116", "details": "The result contains 0 rows", "message": "Cannot coerce result"}, 406)
                return self.reply(rows[0])
            return self.reply(rows)
        self.reply({"message": "Unexpected fixture route"}, 404)

    def do_POST(self):
        path = urlsplit(self.path).path
        body = self.body()
        if path == "/auth/v1/signup":
            STATE["signup"] += 1
            if STATE["mode"] == "auth_failure":
                return self.reply({"code": "unexpected_failure", "msg": "Fixture sign-in failed"}, 503)
            return self.reply(session(make_user()))
        user = self.user()
        if not user:
            return self.reply({"code": "42501", "message": "Authentication required"}, 401)
        if path == "/rest/v1/rpc/get_robot_room_snapshot":
            STATE["snapshots"] += 1
            STATE["reads"] += 1
            room = STATE["room"]
            member = next((m for m in STATE["members"] if m["auth_user_id"] == user["id"]), None)
            if not room or not member or body.get("p_room_id") != ROOM_ID:
                return self.reply({"room": None, "participant_id": None, "members": None, "room_version": None, "error_code": "room_unavailable"})
            # Copy represents the snapshot at request dispatch, even if a fixture
            # deliberately holds its response while the room changes.
            data = {"room": dict(room), "participant_id": member["id"], "members": [dict(m) for m in STATE["members"]],
                    "room_version": room["room_version"], "error_code": None}
            if STATE["mode"] == "snapshot_failure":
                return self.reply({"code": "fixture_offline", "message": "Offline fixture"}, 503)
            if STATE["mode"] == "snapshot_delay":
                time.sleep(2)
            return self.reply(data)
        if path == "/rest/v1/rpc/start_robot_room":
            STATE["starts"] += 1
            room = STATE["room"]
            member = next((m for m in STATE["members"] if m["auth_user_id"] == user["id"]), None)
            if not room or not member or body.get("p_room_id") != ROOM_ID:
                return self.reply({"room_id": None, "status": None, "started_at": None, "room_version": None, "already_started": None, "error_code": "room_unavailable"})
            if member["role"] != "organizer" or room["created_by"] != user["id"] or STATE["mode"] == "start_denied":
                return self.reply({"room_id": None, "status": None, "started_at": None, "room_version": None, "already_started": None, "error_code": "not_organizer"})
            time.sleep(0.3)
            already = room["status"] != "waiting"
            if not already:
                room.update(status="task_assignment", started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            room_version=str(int(room["room_version"]) + 1))
            if STATE["mode"] == "start_uncertain":
                return self.reply({"message": "Response lost after fixture commit"}, 503)
            return self.reply({"room_id": ROOM_ID, "status": room["status"], "started_at": room["started_at"],
                               "room_version": room["room_version"], "already_started": already, "error_code": None})
        if path == "/rest/v1/rpc/create_robot_room":
            STATE["creates"] += 1
            time.sleep(0.35)
            if STATE["mode"] == "rate_limited":
                return self.reply({"room_id": None, "participant_id": None, "error_code": "rate_limited"})
            member = create_fixture_room(user["id"], body["p_nickname"])
            if STATE["mode"] == "uncertain":
                return self.reply({"message": "Fixture response lost after commit"}, 503)
            return self.reply({"room_id": ROOM_ID, "participant_id": member["id"], "error_code": None})
        if path == "/rest/v1/rpc/join_robot_room":
            STATE["joins"] += 1
            if not STATE["room"] or body["p_join_code"] != CODE:
                return self.reply({"room_id": None, "participant_id": None, "error_code": "room_unavailable"})
            member = next((m for m in STATE["members"] if m["auth_user_id"] == user["id"]), None)
            if not member:
                member = {"id": str(uuid.uuid4()), "room_id": ROOM_ID, "auth_user_id": user["id"],
                          "nickname": body["p_nickname"], "role": "participant",
                          "joined_at": "2026-10-11T00:00:00Z", "updated_at": "2026-10-11T00:00:00Z"}
                if STATE["room"]["status"] != "waiting":
                    return self.reply({"room_id": None, "participant_id": None, "error_code": "room_unavailable"})
                STATE["members"].append(member)
                STATE["room"]["room_version"] = str(int(STATE["room"]["room_version"]) + 1)
            return self.reply({"room_id": ROOM_ID, "participant_id": member["id"], "error_code": None})
        self.reply({"message": "Unexpected fixture write"}, 400)


def wait_server(process):
    opener = build_opener(ProxyHandler({}))
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError("Fixture Next.js server exited; inspect local artifacts")
        try:
            if opener.open(APP, timeout=1).status == 200:
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("Fixture Next.js server did not become ready")


def tests(browser):
    blocked = []
    cases = []

    def context(width=390):
        ctx = browser.new_context(viewport={"width": width, "height": 844}, is_mobile=width <= 390, has_touch=width <= 390)
        def guard(route):
            url = urlsplit(route.request.url)
            if url.hostname in ("127.0.0.1", "localhost") and url.port in (APP_PORT, API_PORT):
                route.continue_()
            else:
                blocked.append(url.hostname)
                route.abort()
        ctx.route("**/*", guard)
        return ctx

    def passed(name):
        cases.append(name)
        print(f"PASS {name}", flush=True)

    def no_overflow(page):
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Horizontal overflow"

    def submit(page, name):
        page.get_by_label("Your nickname").fill(name)
        page.get_by_role("button", name="Create my Robot" if "/create" in page.url else "Join this Robot").click()

    def ready(page):
        expect(page.get_by_role("heading", name="In this room")).to_be_visible(timeout=15000)
        expect(page.get_by_text("QR code invitation", exact=True)).to_be_visible()

    def lobby_layout(page, role, width):
        message = "Your group is gathering. You can start training whenever you’re ready." if role == "organizer" else "Waiting for your group to begin training."
        status = page.get_by_text(message, exact=True)
        expect(status).to_be_visible()
        members = page.get_by_role("heading", name="In this room").bounding_box()
        invitation = page.get_by_role("heading", name="Invite your people").bounding_box()
        waiting = status.bounding_box()
        if width < 768:
            assert members["y"] < waiting["y"] < invitation["y"], "Mobile lobby must prioritize members, waiting status, then invitations"
        else:
            assert waiting["y"] < members["y"] and invitation["x"] < members["x"], "Desktop lobby keeps its two-column layout"
        assert page.get_by_role("button", name="Start Training", exact=True).count() == (1 if role == "organizer" else 0)

    def qr_disclosure(page):
        summary = page.get_by_text("QR code invitation", exact=True)
        qr = page.get_by_alt_text("QR code for this room’s invitation link")
        expect(qr).to_be_hidden()
        summary.focus(); summary.press("Enter")
        expect(qr).to_be_visible()
        page.wait_for_function("() => { const image = document.querySelector('details img'); return image?.complete && image.naturalWidth > 0; }")
        no_overflow(page)
        summary.press("Enter")
        expect(qr).to_be_hidden()
        expect(page.get_by_role("button", name="Copy invitation link")).to_be_visible()

    reset()
    with context() as ctx:
        page = ctx.new_page()
        for width in (320, 390, 768, 1440):
            page.set_viewport_size({"width": width, "height": 900})
            page.goto(APP)
            no_overflow(page)
            expect(page.get_by_role("link", name="Create a Robot")).to_have_attribute("href", "/create")
            expect(page.get_by_role("link", name="Join a Robot")).to_have_attribute("href", "/join")
            if width in (390, 1440): page.screenshot(path=str(ARTIFACTS / f"home-{width}.png"), full_page=True)
        page.get_by_role("link", name="Create a Robot").click()
        expect(page.get_by_role("heading", name="Create a Robot")).to_be_visible()
        assert STATE["signup"] == 0
    passed("homepage navigation and responsive layout; no visitor signup")

    reset()
    with context(320) as ctx:
        page = ctx.new_page(); page.goto(APP + "/create")
        expect(page.get_by_text("First, create a room. Your group will bring the robot to life together.", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Return to my room")).to_be_visible()
        for width in (320, 390, 768, 1440):
            page.set_viewport_size({"width": width, "height": 900}); no_overflow(page)
            if width == 390: page.screenshot(path=str(ARTIFACTS / "create-390.png"), full_page=True)
        page.set_viewport_size({"width": 320, "height": 844})
        page.get_by_role("button", name="Create my Robot").click()
        expect(page.locator("main [role=alert]")).to_contain_text("nickname")
        assert STATE["signup"] == STATE["creates"] == 0
        page.get_by_label("Your nickname").fill("River")
        page.evaluate("document.querySelector('form').requestSubmit(); document.querySelector('form').requestSubmit();")
        expect(page.get_by_role("button", name="Creating your room…")).to_be_disabled()
        ready(page)
        assert STATE["creates"] == STATE["signup"] == 1
        expect(page.get_by_text("1 member", exact=True)).to_be_visible()
        expect(page.get_by_label("Invitation link")).to_have_value(APP + "/join?code=" + CODE)
        for width in (320, 390, 768, 1440):
            page.set_viewport_size({"width": width, "height": 900}); no_overflow(page)
            lobby_layout(page, "organizer", width)
            qr_disclosure(page)
            page.screenshot(path=str(ARTIFACTS / f"lobby-{width}.png"), full_page=True)
        original = STATE["members"][0]["auth_user_id"]
        page.reload(); ready(page)
        assert STATE["signup"] == 1 and STATE["members"][0]["auth_user_id"] == original
        page.get_by_role("button", name="Copy invitation link").click()
        expect(page.get_by_role("status").filter(has_text="copied")).to_be_visible()
        ctx.clear_cookies(); page.reload()
        expect(page.get_by_role("heading", name="We can’t find your saved place")).to_be_visible()
        page.goto(APP + "/join?code=" + CODE); submit(page, "Lost session")
        expect(page.locator("main [role=alert]")).to_contain_text("haven’t signed you in as someone new")
        assert STATE["signup"] == 1
    passed("validation, loading, duplicate-submit prevention, creation, QR, clipboard, and session reload")

    reset(seed=True)
    with context() as ctx:
        page = ctx.new_page(); page.goto(APP + "/join?code=abcd-efgh-jklm")
        for width in (320, 390, 768, 1440):
            page.set_viewport_size({"width": width, "height": 900}); no_overflow(page)
            if width == 390: page.screenshot(path=str(ARTIFACTS / "join-390.png"), full_page=True)
        expect(page.get_by_label("Room invitation code")).to_have_value("abcd-efgh-jklm")
        submit(page, "Brook"); ready(page)
        expect(page.get_by_text("2 members", exact=True)).to_be_visible()
        for width in (320, 390, 768, 1440):
            page.set_viewport_size({"width": width, "height": 900}); no_overflow(page)
            lobby_layout(page, "participant", width)
            qr_disclosure(page)
        membership = next(m for m in STATE["members"] if m["nickname"] == "Brook")
        page.reload(); ready(page)
        page.goto(APP + "/join?code=" + CODE); submit(page, "Changed nickname"); ready(page)
        assert len(STATE["members"]) == 2 and STATE["signup"] == 1
        assert membership in STATE["members"] and membership["nickname"] == "Brook" and membership["role"] == "participant"
        page.get_by_role("button", name="Refresh members").click()
        expect(page.get_by_role("button", name="Refresh members")).to_be_enabled()
        no_overflow(page)
    passed("invitation URLs, code normalization, joining, preserved membership and nickname, manual refresh")

    reset(seed=True)
    with context() as ctx:
        page = ctx.new_page(); page.goto(APP + "/rooms/" + ROOM_ID)
        expect(page.get_by_role("heading", name="We can’t find your saved place")).to_be_visible()
        assert STATE["signup"] == 0
        page.goto(APP + "/join?code=BAD"); submit(page, "Outsider")
        expect(page.locator("main [role=alert]")).to_contain_text("12-character")
        assert STATE["signup"] == 0
        page.get_by_label("Room invitation code").fill("ZZZZZZZZZZZZ")
        page.get_by_role("button", name="Join this Robot").click()
        expect(page.locator("main [role=alert]")).to_contain_text("unavailable")
        page.goto(APP + "/rooms/" + ROOM_ID)
        expect(page.get_by_role("heading", name="This room isn’t available to you")).to_be_visible()
        assert page.get_by_text(CODE, exact=True).count() == 0
        assert page.get_by_alt_text("QR code for this room’s invitation link").count() == 0
    passed("invalid code, unavailable invitation, lost session, and unauthorized room metadata suppression")

    reset(mode="uncertain")
    with context() as ctx:
        page = ctx.new_page(); page.goto(APP + "/create"); submit(page, "Uncertain")
        expect(page.locator("main [role=alert]")).to_contain_text("confirm whether")
        expect(page.get_by_role("button", name="Create my Robot")).to_be_disabled()
        page.reload()
        expect(page.get_by_role("heading", name="Find your room")).to_be_visible()
        expect(page.get_by_role("button", name="Create my Robot")).to_be_disabled()
        page.get_by_role("button", name="Return to my room").click()
        page.get_by_role("link", name=CODE + " Return to room →").click(); ready(page)
        assert STATE["creates"] == 1
    passed("uncertain creation survives reload and recovers through authorized reads without another RPC")

    reset(mode="read_failure")
    with context() as ctx:
        page = ctx.new_page(); page.goto(APP + "/create"); submit(page, "Confirmed")
        expect(page.locator("main [role=alert]")).to_contain_text("room was created")
        page.get_by_role("link", name="Return to my room").click(); ready(page)
        assert STATE["creates"] == 1
    passed("confirmed creation with failed detail read recovers by room ID")

    reset(mode="rate_limited")
    with context() as ctx:
        page = ctx.new_page(); page.goto(APP + "/create"); submit(page, "Limited")
        expect(page.locator("main [role=alert]")).to_contain_text("Too many requests")
        expect(page.get_by_role("button", name="Create my Robot")).to_be_enabled()
        assert STATE["room"] is None
    passed("HTTP 200 error_code rejection never becomes a successful lobby")

    reset(mode="auth_failure")
    with context() as ctx:
        page = ctx.new_page(); page.goto(APP + "/create"); submit(page, "Retry")
        expect(page.locator("main [role=alert]")).to_contain_text("haven’t signed you in as someone new")
        STATE["mode"] = "normal"
        page.get_by_role("button", name="Create my Robot").click()
        expect(page.locator("main [role=alert]")).to_contain_text("haven’t signed you in as someone new")
        assert STATE["signup"] == 1
        page.get_by_role("checkbox").check()
        page.get_by_role("button", name="Create my Robot").click(); ready(page)
        assert STATE["signup"] == 2 and len(STATE["users"]) == 1
    passed("interrupted signup fails closed and requires explicit acknowledged retry")

    reset()
    with context() as ctx:
        ctx.add_init_script("Object.defineProperty(Navigator.prototype, 'locks', {get: () => undefined});")
        page = ctx.new_page(); page.goto(APP + "/create"); submit(page, "No locks")
        expect(page.locator("main [role=alert]")).to_contain_text("confirm who you are")
        assert STATE["signup"] == STATE["creates"] == 0
    passed("unsupported cross-tab coordination fails closed")

    reset(seed=True)
    with context() as ctx:
        pages = [ctx.new_page(), ctx.new_page()]
        for index, page in enumerate(pages):
            page.goto(APP + "/join?code=" + CODE)
            page.get_by_label("Your nickname").fill(f"Tab {index + 1}")
        for page in pages:
            page.evaluate("document.querySelector('form').requestSubmit()")
        for page in pages: ready(page)
        assert STATE["signup"] == 1 and len(STATE["members"]) == 2
    passed("two tabs coordinate initial signup and preserve a single joined membership")

    reset()
    with context() as ctx:
        page = ctx.new_page(); page.goto(APP + "/create"); submit(page, "Recoverable"); ready(page)
        STATE["mode"] = "user_read_failure"
        page.get_by_role("button", name="Refresh members").click()
        expect(page.get_by_role("heading", name="We couldn’t load this room")).to_be_visible()
        assert page.get_by_text(CODE, exact=True).count() == 0
        assert page.get_by_alt_text("QR code for this room’s invitation link").count() == 0
        STATE["mode"] = "normal"
        page.get_by_role("button", name="Return to my room").click(); ready(page)
        assert STATE["signup"] == 1
    passed("verification outage hides room details and restores the same identity without signup")

    reset()
    with context() as ctx:
        page = ctx.new_page(); page.goto(APP + "/create"); submit(page, "Polling"); ready(page)
        newcomer = make_user()
        STATE["members"].append({"id": str(uuid.uuid4()), "room_id": ROOM_ID, "auth_user_id": newcomer["id"],
                                 "nickname": "Arriving", "role": "participant", "joined_at": "2026-10-11T00:00:00Z", "updated_at": "2026-10-11T00:00:00Z"})
        STATE["room"]["room_version"] = str(int(STATE["room"]["room_version"]) + 1)
        expect(page.get_by_text("2 members", exact=True)).to_be_visible(timeout=20000)
        before = STATE["reads"]
        page.evaluate("Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'}); document.dispatchEvent(new Event('visibilitychange'));")
        page.wait_for_timeout(16000)
        assert STATE["reads"] == before
    passed("membership polling updates visible pages and pauses while hidden")

    assert not blocked, f"Unexpected non-loopback network attempts: {blocked}"
    (ARTIFACTS / "results.json").write_text(json.dumps({"passed": cases, "fixture_only": True, "live_users_created": 0}, indent=2))
    print(json.dumps({"browser_cases_passed": len(cases), "fixture_only": True, "artifacts": str(ARTIFACTS)}), flush=True)


def main():
    for port in (APP_PORT, API_PORT):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    environment = os.environ.copy()
    environment.update(NEXT_PUBLIC_SUPABASE_URL=API,
                       NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_phase1bfixture",
                       NEXT_TELEMETRY_DISABLED="1")
    reset()
    fixture = ThreadingHTTPServer(("127.0.0.1", API_PORT), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    process = None
    try:
        with (ARTIFACTS / "build.log").open("w") as build:
            subprocess.run(["npm", "run", "build"], cwd=ROOT, env=environment, stdout=build, stderr=subprocess.STDOUT, check=True)
        with (ARTIFACTS / "server.log").open("w") as output:
            process = subprocess.Popen(["npm", "start", "--", "--hostname", "127.0.0.1", "--port", str(APP_PORT)],
                                       cwd=ROOT, env=environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            wait_server(process)
            with sync_playwright() as runner:
                executable = shutil.which("chromium") or shutil.which("chromium-browser")
                browser = runner.chromium.launch(executable_path=executable, headless=True)
                try:
                    tests(browser)
                finally:
                    browser.close()
    finally:
        if process and process.poll() is None:
            import signal
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
        fixture.shutdown(); fixture.server_close()
        print(f"Local artifacts: {ARTIFACTS}", flush=True)


if __name__ == "__main__":
    main()
