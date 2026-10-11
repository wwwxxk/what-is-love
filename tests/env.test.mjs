import assert from "node:assert/strict";
import test from "node:test";
import { readSupabaseConfig } from "../src/lib/config/env.ts";

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
};

test("missing config and template placeholders leave Supabase unconfigured", () => {
  assert.equal(readSupabaseConfig({}), null);
  assert.equal(readSupabaseConfig({
    NEXT_PUBLIC_SUPABASE_URL: "https://your-project.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "your-supabase-publishable-key",
  }), null);
});

test("valid configuration is normalized without a network request", () => {
  assert.deepEqual(readSupabaseConfig({ ...valid, NEXT_PUBLIC_SUPABASE_URL: " https://example.supabase.co/ " }), {
    url: "https://example.supabase.co", publishableKey: valid.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
});

test("partially configured integration reports the missing requirement", () => {
  assert.throws(() => readSupabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: valid.NEXT_PUBLIC_SUPABASE_URL }), /Set both/);
  assert.throws(() => readSupabaseConfig({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: valid.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY }), /Set both/);
});

test("private and legacy keys cannot enter the public client", () => {
  for (const key of ["sb_secret_example", "eyJhbGciOiJIUzI1NiJ9.example", "sb_publishable_"]) {
    assert.throws(() => readSupabaseConfig({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key }), /publishable key/);
  }
});

test("malformed and unsafe origins are rejected without exposing values", () => {
  for (const url of ["not-a-url", "http://example.supabase.co", "ftp://example.com", "https://user:password@example.com", "https://example.com/rest/v1", "https://example.com/?token=x", "https://example.com/#x"]) {
    assert.throws(() => readSupabaseConfig({ ...valid, NEXT_PUBLIC_SUPABASE_URL: url }), /NEXT_PUBLIC_SUPABASE_URL/);
  }
});

test("local Supabase HTTP origins are supported for future development", () => {
  for (const url of ["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"]) {
    assert.equal(readSupabaseConfig({ ...valid, NEXT_PUBLIC_SUPABASE_URL: url }).url, url);
  }
});
