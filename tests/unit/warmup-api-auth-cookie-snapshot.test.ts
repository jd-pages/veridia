import { test } from "vitest";
import assert from "node:assert/strict";
import { captureWarmupApiAuthCookieSnapshot, AUTH_COOKIE_SNAPSHOT_LABEL, AUTH_COOKIE_SNAPSHOT_BUDGET_MS, AuthCookieSnapshotError } from "../../scripts/testing/warmup-api-auth-cookie-snapshot.mjs";

const baseURL = "http://127.0.0.1:49173";
const syntheticValue = "SYNTHETIC_IN_MEMORY_AUTH_TOKEN_ONLY_NOT_REAL_SECRET";
const epoch = 1_800_000_000_000;
const validCookie = (overrides: Record<string, unknown> = {}) => ({ name: "veridia_local_session", value: syntheticValue, domain: "127.0.0.1", path: "/", expires: epoch / 1000 + 3600, httpOnly: true, secure: false, sameSite: "Lax", ...overrides });

function fixture(cookies: unknown = [validCookie()]) {
  let monotonic = 0;
  let epochValue = epoch;
  let pendingTimer: { fn: () => void; budgetMs: number } | undefined;
  const timers: { fn: () => void; budgetMs: number }[] = [];
  const clears: unknown[] = [];
  const calls: unknown[][] = [];
  let provider: () => unknown = () => cookies;
  const context = {
    cookies(...args: unknown[]) { calls.push(args); return provider(); },
    get storageState() { throw new Error("DOM_ORIGIN_STORAGE_MUST_NOT_BE_QUERIED"); },
    get newPage() { throw new Error("NO_DOM_PAGE_MAY_BE_CREATED"); },
    get request() { throw new Error("NO_EXTRA_LOGIN_OR_REQUEST"); },
  };
  const clock = {
    now: () => monotonic,
    epochNow: () => epochValue,
    setTimer(fn: () => void, budgetMs: number) { const handle = { fn, budgetMs }; timers.push(handle); pendingTimer = handle; return handle; },
    clearTimer(handle: unknown) { clears.push(handle); },
  };
  return { context, clock, calls, timers, clears, cookies,
    set now(value: number) { monotonic = value; },
    set epochNow(value: number) { epochValue = value; },
    set provider(fn: () => unknown) { provider = fn; },
    fireTimer() { assert.ok(pendingTimer); pendingTimer.fn(); },
  };
}

function pure(name: string, fn: () => void | Promise<void>) { test(name, fn); }

pure("captures one exact URL-scoped HttpOnly API cookie without DOM or extra login", async () => {
  const f = fixture();
  const result = await captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock);
  assert.deepEqual(f.calls, [[baseURL]]);
  assert.deepEqual(result.storageState, { cookies: [validCookie()], origins: [] });
  assert.equal(result.measurement.label, AUTH_COOKIE_SNAPSHOT_LABEL);
  assert.equal(result.measurement.elapsedMs, 0);
  assert.equal(result.measurement.providerCalls, 1);
  assert.equal(f.timers[0].budgetMs, 2000);
  assert.equal(AUTH_COOKIE_SNAPSHOT_BUDGET_MS, 2000);
  assert.equal(f.clears.length, 1);
});

pure("result uses detached canonical cookie clone and never retains provider arrays or extra fields", async () => {
  const original = validCookie({ extra: { untrusted: true } });
  const providerCookies = [original, { name: "unrelated", value: "UNRELATED_SYNTHETIC" }];
  const f = fixture(providerCookies);
  const result = await captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock);
  assert.notEqual(result.storageState.cookies, f.cookies);
  assert.notEqual(result.storageState.cookies[0], original);
  assert.equal(Object.hasOwn(result.storageState.cookies[0], "extra"), false);
  original.value = "CHANGED_AFTER_CAPTURE";
  providerCookies.splice(0);
  assert.equal(result.storageState.cookies[0].value, syntheticValue);
});

pure("late provider settlement after deadline cannot assign global state or trigger another call", async () => {
  const f = fixture();
  let settle: (value: unknown) => void = () => { throw new Error("Provider was not started"); };
  f.provider = () => new Promise(resolve => { settle = resolve; });
  let globalState: unknown = null;
  const captured = (async () => {
    const result = await captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock);
    globalState = result.storageState; // Mirrors correct caller assignment after await only.
  })();
  await Promise.resolve();
  f.now = 2000;
  f.fireTimer();
  await assert.rejects(captured, error => error instanceof AuthCookieSnapshotError && error.code === "DEADLINE_EXCEEDED");
  settle([validCookie()]);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(globalState, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.clears.length, 1);
});

pure("overdue actual completion fails even when delayed timer has not fired", async () => {
  const f = fixture();
  f.provider = () => { f.now = 2001; return [validCookie()]; };
  await assert.rejects(captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock), error => error instanceof AuthCookieSnapshotError && error.code === "DEADLINE_EXCEEDED_AFTER_COOKIE_QUERY" && error.elapsedMs === 2001);
  assert.equal(f.calls.length, 1);
});

pure("budget includes queued provider start and does not query after pre-start expiration", async () => {
  const f = fixture();
  const captured = captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock);
  f.now = 2000;
  await assert.rejects(captured, error => error instanceof AuthCookieSnapshotError && error.code === "DEADLINE_EXCEEDED_BEFORE_COOKIE_QUERY");
  assert.equal(f.calls.length, 0);
});

pure("timer receives only original remaining budget after prevalidation even with permanently pending provider", async () => {
  const f = fixture();
  let accesses = 0;
  const context = { get cookies() { if (++accesses === 1) f.now = 500; return f.context.cookies.bind(f.context); } };
  f.provider = () => new Promise(() => {});
  const captured = captureWarmupApiAuthCookieSnapshot(context, baseURL, f.clock);
  await Promise.resolve();
  assert.equal(f.timers[0].budgetMs, 1500);
  assert.equal(f.calls.length, 1);
  f.now = 2000;
  f.fireTimer();
  await assert.rejects(captured, error => error instanceof AuthCookieSnapshotError && error.code === "DEADLINE_EXCEEDED" && error.elapsedMs === 2000);
  assert.equal(f.timers.length, 1);
  assert.equal(f.clears.length, 1);
});

pure("prevalidation exhaustion fails before timer arming or provider query", async () => {
  const f = fixture();
  const context = { get cookies() { f.now = 2000; return f.context.cookies.bind(f.context); } };
  await assert.rejects(captureWarmupApiAuthCookieSnapshot(context, baseURL, f.clock), error => error instanceof AuthCookieSnapshotError && error.code === "DEADLINE_EXCEEDED_BEFORE_TIMER");
  assert.equal(f.timers.length, 0);
  assert.equal(f.calls.length, 0);
});

pure("provider exception is safely classified without leaking message cookie URL or cause", async () => {
  const f = fixture();
  f.provider = () => { throw new Error(`SYNTHETIC_PROVIDER_EXCEPTION_WITH_${syntheticValue}_${baseURL}`); };
  await assert.rejects(captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock), error => {
    assert.ok(error instanceof AuthCookieSnapshotError);
    assert.equal(error.code, "COOKIE_QUERY_FAILED");
    assert.equal(error.stage, "AUTH_COOKIE_SNAPSHOT");
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.ok(!String(error.stack).includes(syntheticValue));
    assert.ok(!JSON.stringify(error).includes(syntheticValue));
    assert.ok(!String(error).includes(baseURL));
    return true;
  });
  assert.equal(f.calls.length, 1);
});

pure("provider throwing our exported error class still cannot leak its arbitrary code or message", async () => {
  const f = fixture();
  f.provider = () => Promise.reject(new AuthCookieSnapshotError(syntheticValue, 0));
  await assert.rejects(captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock), error => {
    assert.ok(error instanceof AuthCookieSnapshotError);
    assert.equal(error.code, "COOKIE_QUERY_FAILED");
    assert.ok(!String(error.stack).includes(syntheticValue));
    assert.ok(!JSON.stringify(error).includes(syntheticValue));
    return true;
  });
});

for (const [name, cookies, code] of [
  ["missing auth cookie", [], "MISSING_AUTH_COOKIE"],
  ["empty auth value", [validCookie({ value: "" })], "EMPTY_AUTH_COOKIE"],
  ["expired auth cookie", [validCookie({ expires: epoch / 1000 - 1 })], "AUTH_COOKIE_EXPIRED_OR_UNPROVEN"],
  ["expiry at current instant", [validCookie({ expires: epoch / 1000 })], "AUTH_COOKIE_EXPIRED_OR_UNPROVEN"],
  ["unproven session-cookie sentinel", [validCookie({ expires: -1 })], "AUTH_COOKIE_EXPIRED_OR_UNPROVEN"],
  ["foreign domain", [validCookie({ domain: "localhost" })], "AUTH_COOKIE_SCOPE_MISMATCH"],
  ["foreign path", [validCookie({ path: "/other" })], "AUTH_COOKIE_SCOPE_MISMATCH"],
  ["cookie not HttpOnly", [validCookie({ httpOnly: false })], "AUTH_COOKIE_NOT_HTTP_ONLY"],
  ["secure-only cookie on HTTP", [validCookie({ secure: true })], "AUTH_COOKIE_TRANSPORT_MISMATCH"],
  ["duplicated auth cookie", [validCookie(), validCookie()], "AMBIGUOUS_AUTH_COOKIE"],
  ["nonarray provider result", {}, "INVALID_COOKIE_RESPONSE"],
]) {
  pure(`rejects ${name} without trusting invalid authentication`, async () => {
    const f = fixture(cookies);
    await assert.rejects(captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock), error => error instanceof AuthCookieSnapshotError && error.code === code);
    assert.equal(f.calls.length, 1);
  });
}

pure("expiry is checked at actual completion rather than captured start", async () => {
  const f = fixture([validCookie({ expires: epoch / 1000 + 1 })]);
  f.provider = () => { f.epochNow = epoch + 1001; return f.cookies; };
  await assert.rejects(captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock), error => error instanceof AuthCookieSnapshotError && error.code === "AUTH_COOKIE_EXPIRED_OR_UNPROVEN");
});

pure("cookie validation is included in original budget and cannot reset deadline", async () => {
  const cookie = validCookie();
  const f = fixture([cookie]);
  Object.defineProperty(cookie, "value", { get() { f.now = 2001; return syntheticValue; } });
  await assert.rejects(captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock), error => error instanceof AuthCookieSnapshotError && error.code === "DEADLINE_EXCEEDED_AFTER_VALIDATION");
  assert.equal(f.timers.length, 1);
});

pure("diagnostic measurement contains no credential values or provider response", async () => {
  const f = fixture();
  f.provider = () => { f.now = 19; return f.cookies; };
  const result = await captureWarmupApiAuthCookieSnapshot(f.context, baseURL, f.clock);
  assert.equal(result.measurement.elapsedMs, 19);
  assert.ok(!JSON.stringify(result.measurement).includes(syntheticValue));
  assert.equal(Object.hasOwn(result.measurement, "cookies"), false);
  assert.equal(result.measurement.clockScope, "JS_OPERATION_START_AND_COMPLETION_NOT_KERNEL_TIME");
});

for (const url of ["http://localhost:49173", "http://127.0.0.1", "https://127.0.0.1:49173", "http://127.0.0.1:49173/other", "http://127.0.0.1:49173/?secret=bad", "http://user:password@127.0.0.1:49173", "not-a-url"]) {
  pure(`rejects nonexact local server scope ${url.replace(/user:password/, "REDACTED")}`, async () => {
    const f = fixture();
    await assert.rejects(captureWarmupApiAuthCookieSnapshot(f.context, url, f.clock), error => error instanceof AuthCookieSnapshotError && error.code === "INVALID_LOCAL_BASE_URL");
    assert.equal(f.calls.length, 0);
  });
}
