"""Phase 1B regressions plus Phase 1C UI/SDK contract tests, all loopback fixtures.

Phoenix messages are mocked with Playwright WebSocket routing. This tests the real
browser SDK/controller but NOT Supabase service authorization or hosted delivery.
No real JWT, live identity, room, database connection, or TLS bypass is used.
"""
import json
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import expect
import sys
sys.dont_write_bytecode = True
import phase1b as base

phase1b_tests = base.tests
base.ARTIFACTS = Path(tempfile.mkdtemp(prefix="what-is-love-phase1c-browser-"))


class SocketFixture:
    def __init__(self):
        self.clients = []
        self.joins = 0
        self.leaves = 0
        self.published = 0
        self.remote_attempts = []

    def connect(self, ws):
        url = urlsplit(ws.url)
        if url.hostname != "127.0.0.1" or url.port != base.API_PORT:
            self.remote_attempts.append(url.hostname)
            ws.close()
            return
        client = {"ws": ws, "topics": set(), "array": False, "closed": False}
        self.clients.append(client)
        # Playwright's page-close callback omits code/reason on normal navigation
        # in this runtime. phx_leave removes topics; fixture disconnect marks closed.

        def message(data):
            packet = json.loads(data)
            if isinstance(packet, list):
                join_ref, ref, topic, event, payload = packet
                client["array"] = True
            else:
                join_ref, ref = packet.get("join_ref"), packet.get("ref")
                topic, event, payload = packet["topic"], packet["event"], packet["payload"]
            status = "ok"
            response = {}
            if event == "phx_join":
                assert payload["config"]["private"] is True
                assert not payload["config"]["presence"]["enabled"]
                # Fixture authorization only; actual RLS is tested in PostgreSQL.
                token = payload.get("access_token", "")
                import base64
                try:
                    uid = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["sub"]
                    member = next(m for m in base.STATE["members"] if m["auth_user_id"] == uid)
                    expected = "realtime:wil:room:" + base.ROOM_ID + ":member:" + member["id"]
                    if topic != expected:
                        status = "error"
                except (IndexError, KeyError, ValueError, StopIteration):
                    status = "error"
                if status == "ok":
                    self.joins += 1
                    client["topics"].add(topic)
                    response = {"postgres_changes": []}
            elif event == "phx_leave":
                self.leaves += 1
                client["topics"].discard(topic)
            elif event in ("broadcast", "presence"):
                self.published += 1
                status = "error"
            if event == "access_token":
                return
            reply = {"status": status, "response": response}
            packet = [join_ref, ref, topic, "phx_reply", reply] if client["array"] else {
                "join_ref": join_ref, "ref": ref, "topic": topic, "event": "phx_reply", "payload": reply}
            ws.send(json.dumps(packet))
        ws.on_message(message)

    def notify(self, duplicate=1):
        for client in self.clients:
            if client["closed"]:
                continue
            for topic in client["topics"]:
                payload = {"type": "broadcast", "event": "room_changed",
                           "payload": {"room_version": base.STATE["room"]["room_version"]}}
                packet = [None, None, topic, "broadcast", payload] if client["array"] else {
                    "topic": topic, "event": "broadcast", "payload": payload}
                for _ in range(duplicate):
                    client["ws"].send(json.dumps(packet))

    def disconnect(self):
        for client in self.clients:
            if not client["closed"]:
                client["ws"].close(code=1012, reason="Local fixture reconnect test")
                client["closed"] = True


def tests(browser):
    phase1b_tests(browser)
    cases, blocked = [], []

    def passed(name):
        cases.append(name)
        print("PASS " + name, flush=True)

    def context(width=390):
        ctx = browser.new_context(viewport={"width": width, "height": 844},
                                  is_mobile=width == 390, has_touch=width == 390)
        def guard(route):
            url = urlsplit(route.request.url)
            if url.hostname == "127.0.0.1" and url.port in (base.APP_PORT, base.API_PORT):
                route.continue_()
            else:
                blocked.append(url.hostname); route.abort()
        ctx.route("**/*", guard)
        sockets = SocketFixture()
        ctx.route_web_socket("**/*", sockets.connect)
        return ctx, sockets

    def ready(page):
        expect(page.get_by_role("heading", name="In this room")).to_be_visible(timeout=15000)
        expect(page.get_by_text("Live room updates are connected.", exact=False)).to_be_visible(timeout=15000)

    def create(page):
        page.goto(base.APP + "/create")
        page.get_by_label("Your nickname").fill("River")
        page.get_by_role("button", name="Create my Robot").click()
        ready(page)

    def prepare(page):
        expect(page.get_by_role("heading", name="Training Preparation", exact=True)).to_be_visible(timeout=15000)
        for dimension in ["WHO", "WHAT", "WHEN", "WHERE", "HOW", "FEELING"]:
            expect(page.get_by_role("heading", name=dimension, exact=True)).to_be_visible()
        assert page.get_by_role("button", name="Continue", exact=True).count() == 0
        assert page.get_by_role("button", name="Start Training", exact=True).count() == 0
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")

    def capture(page, label):
        for width in (390, 1440):
            page.set_viewport_size({"width": width, "height": 900})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(base.ARTIFACTS / (label + "-" + str(width) + ".png")), full_page=True)

    base.reset()
    ctx, sockets = context()
    with ctx:
        page = ctx.new_page(); create(page)
        expect(page.get_by_text("1 member", exact=True)).to_be_visible()
        capture(page, "organizer-lobby")
        page.get_by_role("button", name="Start Training", exact=True).click()
        expect(page.get_by_role("dialog")).to_be_visible()
        expect(page.get_by_role("dialog")).to_contain_text("New participants won’t be able to join")
        capture(page, "start-confirmation")
        page.get_by_role("button", name="Keep gathering").click()
        expect(page.get_by_role("dialog")).to_be_hidden()
        assert base.STATE["starts"] == 0
        page.get_by_role("button", name="Start Training", exact=True).click()
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_be_hidden()
        assert base.STATE["starts"] == 0
        page.get_by_role("button", name="Start Training", exact=True).click()
        page.get_by_role("button", name="Yes, start training").evaluate("(button) => { button.click(); button.click(); }")
        prepare(page)
        assert base.STATE["starts"] == 1 and len(base.STATE["members"]) == 1
        capture(page, "organizer-preparation")
        identity = base.STATE["members"][0]["auth_user_id"]
        page.reload(); prepare(page)
        assert base.STATE["signup"] == 1 and base.STATE["members"][0]["auth_user_id"] == identity
        page.get_by_role("link", name="← Welcome").click()
        page.wait_for_timeout(200)
        assert sockets.leaves >= 1 and sockets.published == 0 and not sockets.remote_attempts
    passed("organizer alone, confirmation/cancel/Escape, duplicate submit, preparation, refresh identity, channel cleanup")

    base.reset(seed=True)
    ctx, sockets = context()
    with ctx:
        page = ctx.new_page(); page.goto(base.APP + "/join?code=" + base.CODE)
        page.get_by_label("Your nickname").fill("Brook")
        page.get_by_role("button", name="Join this Robot").click(); ready(page)
        assert page.get_by_role("button", name="Start Training", exact=True).count() == 0
        capture(page, "participant-lobby")
        newcomer = base.make_user()
        base.STATE["members"].append({"id": "00000000-0000-4000-8000-000000000030",
            "room_id": base.ROOM_ID, "auth_user_id": newcomer["id"], "nickname": "Sky",
            "role": "participant", "joined_at": "2026-10-11T00:00:00Z", "updated_at": "2026-10-11T00:00:00Z"})
        base.STATE["room"]["room_version"] = "3"
        base.STATE["mode"] = "snapshot_delay"
        before = base.STATE["snapshots"]
        sockets.notify(duplicate=10)
        deadline = time.monotonic() + 5
        while base.STATE["snapshots"] == before and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert base.STATE["snapshots"] > before
        base.STATE["room"].update(status="task_assignment", started_at="2026-10-11T00:00:00Z", room_version="4")
        sockets.notify(duplicate=10)
        base.STATE["mode"] = "normal"
        prepare(page)
        assert base.STATE["snapshots"] - before <= 3
        assert base.STATE["starts"] == 0
        expect(page.get_by_role("heading", name="Your group · 3 members")).to_be_visible()
        capture(page, "participant-preparation")
        page.reload(); prepare(page)
        assert base.STATE["signup"] == 1 and len(base.STATE["members"]) == 3
        assert sockets.published == 0 and not sockets.remote_attempts
    passed("participant start hidden, duplicate signals coalesced, change during refresh retained, snapshot transition and reload")

    for mode in ("start_denied", "start_uncertain"):
        base.reset()
        ctx, sockets = context()
        with ctx:
            page = ctx.new_page(); create(page)
            base.STATE["mode"] = mode
            page.get_by_role("button", name="Start Training", exact=True).click()
            page.get_by_role("button", name="Yes, start training").click()
            if mode == "start_denied":
                expect(page.locator("main [role=alert]")).to_contain_text("Only this room")
                expect(page.get_by_role("heading", name="Waiting Lobby")).to_be_visible()
                assert base.STATE["room"]["status"] == "waiting"
            else:
                prepare(page)
            assert base.STATE["starts"] == 1
    passed("HTTP 200 organizer denial and uncertain committed start handled without automatic resubmission")

    base.reset()
    ctx, sockets = context()
    with ctx:
        page = ctx.new_page(); create(page)
        base.STATE["mode"] = "snapshot_failure"
        page.get_by_role("button", name="Refresh members").click()
        expect(page.get_by_role("heading", name="We couldn’t load this room")).to_be_visible()
        assert page.get_by_text(base.CODE, exact=True).count() == 0
        base.STATE["mode"] = "normal"
        page.get_by_role("button", name="Return to my room").click(); ready(page)
        base.STATE["members"].clear(); sockets.notify()
        expect(page.get_by_role("heading", name="This room isn’t available to you")).to_be_visible()
        assert page.get_by_text(base.CODE, exact=True).count() == 0
        assert sockets.leaves >= 1 and base.STATE["signup"] == 1
    passed("snapshot failure hides details, original identity recovery, membership revocation and channel removal")

    base.reset()
    ctx, sockets = context()
    with ctx:
        page = ctx.new_page(); create(page)
        before = sockets.joins; sockets.disconnect()
        base.STATE["room"].update(status="task_assignment", started_at="2026-10-11T00:00:00Z", room_version="2")
        prepare(page)
        deadline = time.monotonic() + 10
        while sockets.joins <= before and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert sockets.joins > before
        ctx.clear_cookies(); page.reload()
        expect(page.get_by_role("heading", name="We can’t find your saved place")).to_be_visible()
        assert base.STATE["signup"] == 1
    passed("SDK reconnect re-snapshots and cookie loss never creates a replacement identity")

    assert not blocked
    (base.ARTIFACTS / "phase1c-results.json").write_text(json.dumps({
        "passed": cases, "fixture_only": True, "hosted_websocket_security_verified": False,
        "live_users_created": 0, "live_rooms_created": 0}, indent=2))
    print(json.dumps({"phase1c_browser_cases_passed": len(cases), "artifacts": str(base.ARTIFACTS)}), flush=True)


if __name__ == "__main__":
    base.tests = tests
    base.main()
