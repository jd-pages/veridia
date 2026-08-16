import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DESKTOP_NODE_RUNTIME } from "../desktop-node-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const distRoot = path.resolve(root, process.env.VERIDIA_NEXT_DIST_DIR || ".next");
const standaloneRoot = path.join(distRoot, "standalone");
const serverEntry = path.join(standaloneRoot, "server.js");
const prismaAliasHook = path.join(root, "desktop", "prisma-alias.cjs");
const bundledNodeExecutable = path.resolve(root, "desktop-runtime", "node", "node.exe");
const standaloneNodeExecutable = bundledNodeExecutable;
const skipBuild = process.argv.includes("--skip-build");
const temporaryRoot = path.join(root, ".playwright", "standalone-runtime", randomUUID());
const gracefulShutdownTimeoutMs = 5_000;
const forcedShutdownTimeoutMs = 5_000;

function fail(message, details = "") {
  throw new Error(`${message}${details ? `\n${details}` : ""}`);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 200 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error || result.status !== 0) {
    fail(options.label || `${executable} ${args.join(" ")} failed`, result.error?.message || `exit code ${result.status}`);
  }
  return result;
}

function normalizedExecutablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertBundledNodeIdentity() {
  if (normalizedExecutablePath(standaloneNodeExecutable) !== normalizedExecutablePath(bundledNodeExecutable)) {
    fail("Standalone server child executable is not the VERIDIA Desktop bundled Node", [
      `selected: ${standaloneNodeExecutable}`,
      `expected: ${bundledNodeExecutable}`,
    ].join("\n"));
  }
  if (!fs.existsSync(bundledNodeExecutable)) {
    fail(`VERIDIA Desktop bundled Node is missing: ${bundledNodeExecutable}`);
  }
  const version = run(bundledNodeExecutable, ["--version"], {
    label: "VERIDIA Desktop bundled Node is not executable",
  }).stdout.trim();
  if (!version) fail("VERIDIA Desktop bundled Node did not report a version");
  if (version !== DESKTOP_NODE_RUNTIME.versionTag) {
    fail(
      `VERIDIA Desktop bundled Node version mismatch: expected ${DESKTOP_NODE_RUNTIME.versionTag}, received ${version}`,
    );
  }
  return version;
}

function runProductionBuild() {
  const expectedDistRoot = path.join(root, ".next");
  if (distRoot !== expectedDistRoot) {
    fail(`Clean standalone smoke only supports the production dist directory: ${expectedDistRoot}`);
  }
  fs.rmSync(distRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  if (process.platform === "win32") {
    run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `call ${npmExecutable} run build`], {
      label: "Clean production build failed",
    });
    return;
  }
  run(npmExecutable, ["run", "build"], { label: "Clean production build failed" });
}

function sqliteUrl(file) {
  return `file:${file.replaceAll("\\", "/")}`;
}

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) fail("Could not reserve a standalone smoke-test port");
  return port;
}

async function waitForReady(child, url, timeoutMs, getSpawnError) {
  const deadline = Date.now() + timeoutMs;
  let lastHttpStatus = null;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) fail("Standalone server child could not be spawned", spawnError.message);
    if (child.exitCode !== null || child.signalCode !== null) {
      fail("Standalone server child exited before becoming healthy", `code=${child.exitCode ?? "none"}, signal=${child.signalCode ?? "none"}`);
    }
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return response;
      lastHttpStatus = response.status;
    } catch {
      // The standalone server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (lastHttpStatus !== null) {
    fail(`Standalone health endpoint did not return HTTP 200 within ${timeoutMs}ms`, `last HTTP status=${lastHttpStatus}`);
  }
  fail(`Standalone health endpoint timed out after ${timeoutMs}ms`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve) => {
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolve({ exited: true, code, signal });
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve({ exited: false, code: null, signal: null });
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode, forced: false };
  }

  child.kill("SIGTERM");
  const gracefulExit = await waitForExit(child, gracefulShutdownTimeoutMs);
  if (gracefulExit.exited) {
    return { code: gracefulExit.code, signal: gracefulExit.signal, forced: false };
  }

  if (!child.pid) fail("Standalone child did not expose a PID for forced cleanup");
  if (process.platform === "win32") {
    const taskkill = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: forcedShutdownTimeoutMs,
      windowsHide: true,
    });
    if (taskkill.error) fail(`Failed to force-stop standalone child process tree (pid=${child.pid})`, taskkill.error.message);
  } else {
    child.kill("SIGKILL");
  }

  const forcedExit = await waitForExit(child, forcedShutdownTimeoutMs);
  if (!forcedExit.exited) {
    fail(`Standalone child process tree did not exit after forced termination (pid=${child.pid}, timeout=${forcedShutdownTimeoutMs}ms)`);
  }
  return { code: forcedExit.code, signal: forcedExit.signal, forced: true };
}

let child;
let stdout = "";
let stderr = "";
try {
  const bundledNodeVersion = assertBundledNodeIdentity();
  if (!skipBuild) runProductionBuild();
  if (!fs.existsSync(serverEntry)) fail(`Standalone server entry is missing: ${serverEntry}`);
  if (!fs.existsSync(prismaAliasHook)) fail(`Desktop Prisma alias hook is missing: ${prismaAliasHook}`);

  fs.mkdirSync(temporaryRoot, { recursive: true });
  const databasePath = path.join(temporaryRoot, "standalone.db");
  fs.writeFileSync(databasePath, "");
  const databaseUrl = sqliteUrl(databasePath);
  run(process.execPath, [path.join(root, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
    env: { DATABASE_URL: databaseUrl },
    label: "Standalone smoke database migration failed",
  });

  const port = await availablePort();
  const startedAt = Date.now();
  let spawnError = null;
  child = spawn(standaloneNodeExecutable, ["--require", prismaAliasHook, serverEntry], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      VERIDIA_APP_ROOT: root,
      VERIDIA_DATA_DIR: temporaryRoot,
      VERIDIA_DATA_LOCATION_CONFIRMED: "true",
      VERIDIA_DESKTOP: "true",
      VERIDIA_DESKTOP_INSTANCE_ID: "standalone-runtime-smoke",
      AI_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.once("error", (error) => { spawnError = error; });
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const baseUrl = `http://127.0.0.1:${port}`;
  let health;
  try {
    health = await waitForReady(child, `${baseUrl}/api/health`, 30_000, () => spawnError);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Standalone server failed to become healthy", [
      `stdout:\n${stdout}`,
      `stderr:\n${stderr}`,
    ].join("\n"));
  }
  const readyMs = Date.now() - startedAt;
  const healthBody = await health.json();
  if (healthBody?.ok !== true || healthBody?.desktop !== true) {
    fail("Standalone health response was not a healthy Desktop response", JSON.stringify(healthBody));
  }
  const login = await fetch(`${baseUrl}/login`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (login.status !== 200) fail(`Standalone login returned HTTP ${login.status}`, await login.text());
  const loginBody = await login.text();
  if (!loginBody.includes("VERIDIA")) fail("Standalone login response did not contain the application marker");

  const exit = await stopChild(child);
  child = undefined;
  process.stdout.write([
    "[standalone runtime] clean build: " + (skipBuild ? "reused formal Production Build" : "PASSED"),
    `[standalone runtime] system Node: ${process.execPath}`,
    `[standalone runtime] Desktop bundled Node: ${bundledNodeExecutable}`,
    `[standalone runtime] bundled Node version: ${bundledNodeVersion}`,
    `[standalone runtime] server child executable: ${standaloneNodeExecutable}`,
    `[standalone runtime] Prisma alias: ${prismaAliasHook}`,
    `[standalone runtime] standalone entry: ${serverEntry}`,
    `[standalone runtime] working directory: ${standaloneRoot}`,
    `[standalone runtime] health: HTTP ${health.status}`,
    `[standalone runtime] login: HTTP ${login.status}`,
    `[standalone runtime] ready: ${readyMs}ms`,
    `[standalone runtime] cleanup: code=${exit.code ?? "none"}, signal=${exit.signal ?? "none"}, forced=${exit.forced}`,
    "[standalone runtime] PASSED",
    "",
  ].join("\n"));
} finally {
  if (child) await stopChild(child);
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
