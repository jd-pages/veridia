export const AUTH_COOKIE_SNAPSHOT_LABEL: "AUTH_COOKIE_SNAPSHOT";
export const AUTH_COOKIE_SNAPSHOT_BUDGET_MS: 2000;
export interface ApiAuthSnapshotCookie {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None";
}
export interface ApiAuthSnapshotMeasurement {
  label: "AUTH_COOKIE_SNAPSHOT"; status: "PASSED"; budgetMs: 2000; elapsedMs: number;
  startedAt: string; completedAt: string;
  clockScope: "JS_OPERATION_START_AND_COMPLETION_NOT_KERNEL_TIME";
  cookieCount: 1; originsCount: 0; providerCalls: 1;
}
export interface ApiAuthSnapshotClock {
  now?: () => number; epochNow?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}
export class AuthCookieSnapshotError extends Error {
  constructor(code: string, elapsedMs: number);
  code: string; stage: "AUTH_COOKIE_SNAPSHOT"; elapsedMs: number; budgetMs: 2000;
}
export function captureWarmupApiAuthCookieSnapshot(context: { cookies(baseURL: string): unknown }, baseURL: string, clock?: ApiAuthSnapshotClock): Promise<{
  storageState: { cookies: ApiAuthSnapshotCookie[]; origins: [] };
  measurement: ApiAuthSnapshotMeasurement;
}>;
