import fs from "node:fs";
import path from "node:path";

// This is not a production session operation. Bind it to the wrapper's
// private nonce, loopback port, actual isolated DB and both isolated profiles.
export function assertIsolatedE2eBrowserTeardown(requestUrl: string, nonce: unknown) {
  const env = process.env;
  const fail = () => { throw new Error("仅当前隔离 E2E 验收允许关闭测试浏览器"); };
  if (env.NODE_ENV === "production" || env.VERIDIA_E2E !== "true" ||
    !env.VERIDIA_E2E_TEARDOWN_NONCE || nonce !== env.VERIDIA_E2E_TEARDOWN_NONCE ||
    !env.DATABASE_URL?.startsWith("file:") || env.DATABASE_URL !== env.E2E_DATABASE_URL) fail();
  const url = new URL(requestUrl);
  // Next dev reconstructs Request.url with its configured localhost hostname,
  // even when the wrapper connects to 127.0.0.1. Both remain loopback-only.
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== env.E2E_PORT) fail();
  const databasePath = env.DATABASE_URL!.slice(5);
  if (!path.isAbsolute(databasePath)) fail();
  const runDirectory = path.dirname(databasePath);
  const runsRoot = path.resolve(process.cwd(), ".playwright", "e2e-runs");
  if (path.dirname(runDirectory) !== runsRoot || path.basename(databasePath) !== "veridia-e2e.db" ||
    fs.lstatSync(runDirectory).isSymbolicLink() || fs.realpathSync(runDirectory) !== runDirectory ||
    fs.realpathSync(runsRoot) !== runsRoot) fail();
  const database = fs.lstatSync(databasePath);
  if (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1 || fs.realpathSync(databasePath) !== databasePath) fail();
  for (const [actual, expected] of [
    [env.XHS_PROFILE_PATH, path.join(runDirectory, "xhs-profile")],
    [env.DOUYIN_PROFILE_PATH, path.join(runDirectory, "douyin-profile")],
  ] as const) {
    if (actual !== expected) fail();
    if (fs.existsSync(expected)) {
      const profile = fs.lstatSync(expected);
      if (!profile.isDirectory() || profile.isSymbolicLink() || fs.realpathSync(expected) !== expected) fail();
    }
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(runDirectory, "run.json"), "utf8"));
  if (metadata.schemaVersion !== 2 || metadata.databasePath !== databasePath ||
    metadata.profilePath !== env.XHS_PROFILE_PATH || metadata.douyinProfilePath !== env.DOUYIN_PROFILE_PATH ||
    String(metadata.port) !== env.E2E_PORT || metadata.nextDistDir !== ".playwright/next-e2e") fail();
}

export function assertIdleE2eBrowserTeardown(runtime: unknown, sessions: readonly unknown[]) {
  const fail = () => { throw new Error("测试浏览器仍有执行或清理中的所有者，禁止关闭"); };
  if (!runtime || typeof runtime !== "object") fail();
  const state = runtime as Record<string, unknown>;
  for (const key of ["effectiveRunnerCount", "activeExtractionCount", "pendingCleanupBarrierCount", "pendingLifecycleOperationCount"])
    if (state[key] !== 0) fail();
  if (state.physicalCloseState !== null || state.physicalCloseFencePresent !== false || sessions.length !== 2) fail();
  const transactions = state.prismaTransactionDiagnostics as Record<string, unknown> | undefined;
  if (transactions?.measurement !== "AVAILABLE" || transactions.singletonRegistered !== true ||
    transactions.wrapperIntact !== true || transactions.pendingTransactionCount !== 0) fail();
  for (const session of sessions) {
    if (!session || typeof session !== "object" || (session as Record<string, unknown>).auditLock !== null) fail();
  }
}
