// Captures an in-memory API authentication cookie, never DOM/localStorage origins.
// Caller assigns its global storage state only AFTER this promise resolves.
import { performance } from "node:perf_hooks";

export const AUTH_COOKIE_SNAPSHOT_LABEL = "AUTH_COOKIE_SNAPSHOT";
export const AUTH_COOKIE_SNAPSHOT_BUDGET_MS = 2_000;
const AUTH_COOKIE_NAME = "veridia_local_session";

export class AuthCookieSnapshotError extends Error {
  constructor(code, elapsedMs) {
    super(`E2E ${AUTH_COOKIE_SNAPSHOT_LABEL}: ${code}`);
    this.name = "AuthCookieSnapshotError";
    this.code = code;
    this.stage = AUTH_COOKIE_SNAPSHOT_LABEL;
    this.elapsedMs = elapsedMs;
    this.budgetMs = AUTH_COOKIE_SNAPSHOT_BUDGET_MS;
    // Deliberately no provider error message, stack, cause, cookie value or URL.
  }
}

function validateBaseURL(baseURL, fail) {
  let url;
  try { url = new URL(baseURL); } catch { throw fail("INVALID_LOCAL_BASE_URL"); }
  if (typeof baseURL !== "string" || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1 || Number(url.port) > 65535 || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw fail("INVALID_LOCAL_BASE_URL");
  }
  return url;
}

function cloneValidatedCookie(cookies, baseURL, epochMs, fail) {
  if (!Array.isArray(cookies)) throw fail("INVALID_COOKIE_RESPONSE");
  const candidates = cookies.filter(cookie => cookie?.name === AUTH_COOKIE_NAME);
  if (candidates.length !== 1) throw fail(candidates.length ? "AMBIGUOUS_AUTH_COOKIE" : "MISSING_AUTH_COOKIE");
  const cookie = candidates[0];
  if (typeof cookie.value !== "string" || cookie.value.length === 0) throw fail("EMPTY_AUTH_COOKIE");
  if (cookie.httpOnly !== true) throw fail("AUTH_COOKIE_NOT_HTTP_ONLY");
  if (cookie.domain !== baseURL.hostname || cookie.path !== "/") throw fail("AUTH_COOKIE_SCOPE_MISMATCH");
  // The actual local createSession contract produces a persistent, finite expiry.
  // A session-cookie sentinel -1 is not accepted as proof of that contract here.
  if (typeof cookie.expires !== "number" || !Number.isFinite(cookie.expires) || cookie.expires * 1000 <= epochMs) throw fail("AUTH_COOKIE_EXPIRED_OR_UNPROVEN");
  if (cookie.secure !== false || !["Lax", "Strict", "None"].includes(cookie.sameSite)) throw fail("AUTH_COOKIE_TRANSPORT_MISMATCH");
  return {
    name: AUTH_COOKIE_NAME,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: true,
    secure: false,
    sameSite: cookie.sameSite,
  };
}

export async function captureWarmupApiAuthCookieSnapshot(context, baseURL, clock = {}) {
  const now = clock.now ?? (() => performance.now());
  const epochNow = clock.epochNow ?? (() => Date.now());
  const armTimer = clock.setTimer ?? setTimeout;
  const disarmTimer = clock.clearTimer ?? clearTimeout;
  const started = now();
  const startedEpochMs = epochNow();
  const deadline = started + AUTH_COOKIE_SNAPSHOT_BUDGET_MS;
  const elapsed = () => now() - started;
  const fail = code => new AuthCookieSnapshotError(code, elapsed());
  const url = validateBaseURL(baseURL, fail);
  if (!context || typeof context.cookies !== "function") throw fail("COOKIE_PROVIDER_UNAVAILABLE");
  let timer;
  try {
    const remaining = deadline - now();
    if (remaining <= 0) throw fail("DEADLINE_EXCEEDED_BEFORE_TIMER");
    // Arm only the remaining original budget, including prior URL/context validation.
    // Late provider success cannot mutate caller state; it only resolves its race loser.
    const deadlineFailure = new Promise((_, reject) => {
      timer = armTimer(() => reject(fail("DEADLINE_EXCEEDED")), remaining);
    });
    const provider = Promise.resolve().then(() => {
      if (now() >= deadline) throw fail("DEADLINE_EXCEEDED_BEFORE_COOKIE_QUERY");
      // Exact current host+port argument, no broad all-cookie capture. Every
      // provider exception is sanitized, including an instance of our error class.
      try { return Promise.resolve(context.cookies(baseURL)).catch(() => { throw fail("COOKIE_QUERY_FAILED"); }); }
      catch { throw fail("COOKIE_QUERY_FAILED"); }
    });
    const cookies = await Promise.race([provider, deadlineFailure]);
    // Delayed timer callbacks cannot permit a late provider success to pass.
    if (now() >= deadline) throw fail("DEADLINE_EXCEEDED_AFTER_COOKIE_QUERY");
    const cookie = cloneValidatedCookie(cookies, url, epochNow(), fail);
    // Validation is included in the same fixed budget; no deadline reset or new login.
    const completed = now();
    if (completed >= deadline) throw fail("DEADLINE_EXCEEDED_AFTER_VALIDATION");
    return {
      storageState: { cookies: [cookie], origins: [] },
      measurement: {
        label: AUTH_COOKIE_SNAPSHOT_LABEL,
        status: "PASSED",
        budgetMs: AUTH_COOKIE_SNAPSHOT_BUDGET_MS,
        elapsedMs: completed - started,
        startedAt: new Date(startedEpochMs).toISOString(),
        completedAt: new Date(epochNow()).toISOString(),
        clockScope: "JS_OPERATION_START_AND_COMPLETION_NOT_KERNEL_TIME",
        cookieCount: 1,
        originsCount: 0,
        providerCalls: 1,
      },
    };
  } finally {
    if (timer !== undefined) disarmTimer(timer);
  }
}
