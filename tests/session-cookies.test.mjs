import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { getSessionCookieOptions } from "../src/lib/supabase/session-cookie-options.ts";
import { updateParticipantSession } from "../src/lib/supabase/proxy.ts";

const config = { url: "https://example.supabase.co", publishableKey: "sb_publishable_example" };
const requestWithCookie = () => new NextRequest("https://example.test/", {
  headers: { cookie: "sb-example-auth-token=local-session-fixture" },
});

test("homepage visitors do not initialize Auth or require configuration", async () => {
  const response = await updateParticipantSession(new NextRequest("https://example.test/"),
    () => assert.fail("No Auth calls for visitors"), () => assert.fail("No config required for visitors"));
  assert.equal(response.status, 200);
  assert.equal(response.cookies.getAll().length, 0);
});

test("missing Supabase configuration keeps the homepage available with stale cookies", async () => {
  const response = await updateParticipantSession(requestWithCookie(),
    () => assert.fail("No Auth calls without config"), () => null);
  assert.equal(response.status, 200);
});

test("refresh writes cookies to both downstream request and browser with non-cacheable headers", async () => {
  const request = requestWithCookie();
  const response = await updateParticipantSession(request, (url, key, { cookies }) => {
    assert.equal(url, config.url);
    assert.equal(key, config.publishableKey);
    assert.equal(cookies.getAll()[0].value, "local-session-fixture");
    return { auth: { getUser: async () => {
      cookies.setAll([{ name: "sb-example-auth-token", value: "refreshed-local-fixture", options: { path: "/", sameSite: "lax", secure: true } }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
        "Expires": "0", "Pragma": "no-cache",
      });
      return {};
    } } };
  }, () => config);
  assert.equal(request.cookies.get("sb-example-auth-token").value, "refreshed-local-fixture");
  assert.equal(response.cookies.get("sb-example-auth-token").value, "refreshed-local-fixture");
  assert.equal(response.cookies.get("sb-example-auth-token").secure, getSessionCookieOptions().secure);
  assert.match(response.headers.get("x-middleware-request-cookie"), /refreshed-local-fixture/);
  assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
  assert.equal(response.headers.get("Expires"), "0");
  assert.equal(response.headers.get("Pragma"), "no-cache");
});

test("multiple cookie writes preserve earlier chunks and first-write-only cache headers", async () => {
  const response = await updateParticipantSession(requestWithCookie(), (_url, _key, { cookies }) => ({ auth: { getUser: async () => {
    cookies.setAll([{ name: "sb-example-auth-token.0", value: "fixture-chunk-0", options: { path: "/" } }], {
      "Cache-Control": "private, no-store", "Expires": "0", "Pragma": "no-cache",
    });
    cookies.setAll([{ name: "sb-example-auth-token.1", value: "fixture-chunk-1", options: { path: "/" } }], {});
    return {};
  } } }), () => config);
  assert.equal(response.cookies.get("sb-example-auth-token.0").value, "fixture-chunk-0");
  assert.equal(response.cookies.get("sb-example-auth-token.1").value, "fixture-chunk-1");
  assert.equal(response.headers.get("Expires"), "0");
  assert.equal(response.headers.get("Pragma"), "no-cache");
});

test("unchanged authenticated requests are still private and non-cacheable", async () => {
  const response = await updateParticipantSession(requestWithCookie(), () => ({ auth: { getUser: async () => ({}) } }), () => config);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("production proxy enforces Secure on every cookie chunk and rejects public cache headers", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const response = await updateParticipantSession(requestWithCookie(), (_url, _key, { cookies, cookieOptions }) => {
      assert.equal(cookieOptions.secure, true);
      return { auth: { getUser: async () => {
        cookies.setAll([0, 1].map((index) => ({ name: `sb-example-auth-token.${index}`, value: "local-fixture", options: { secure: false } })), { "Cache-Control": "public, max-age=300" });
      } } };
    }, () => config);
    for (const cookie of response.cookies.getAll()) assert.equal(cookie.secure, true);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("one cookie policy supports local HTTP development and HTTPS production", () => {
  assert.deepEqual(getSessionCookieOptions("development"), { path: "/", sameSite: "lax", httpOnly: false, secure: false });
  assert.equal(getSessionCookieOptions("production").secure, true);
});
