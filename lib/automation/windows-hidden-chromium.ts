import "server-only";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, BrowserType } from "playwright";
import {
  captureWindowsBrowserProfileOwners,
  releaseWindowsBrowserProfileOwners,
  WindowsBrowserProfileOwnershipError,
  authorizeWindowsBrowserDescendants,
  authorizeInitialWindowsBrowserOwners,
  type WindowsBrowserProcessIdentity,
} from "./windows-browser-process-owner";

const DEVTOOLS_ACTIVE_PORT = "DevToolsActivePort";
const CONNECT_TIMEOUT_MS = 12_000;
const CLOSE_STEP_TIMEOUT_MS = 1_000;
const PROCESS_EXIT_TIMEOUT_MS = 3_000;
const PROFILE_RELEASE_ATTEMPTS = 5;
const PROFILE_RELEASE_INTERVAL_MS = 100;

type HiddenChromiumConnection = {
  browser: Browser;
  context: BrowserContext;
  processId: number | null;
  reusedProcess: boolean;
  executablePath: string;
  browserVersion: string;
  remoteDebuggingMode: "port" | "playwright";
  remoteDebuggingPolicy: "ALLOWED" | "BLOCKED" | "NOT_CONFIGURED";
  close: () => Promise<void>;
};

export type HiddenChromiumLaunchDiagnostic = {
  phase: string;
  occurredAt: string;
  elapsedMs: number;
  processId?: number;
  exitCode?: number | null;
  stderrBytes?: number;
};

function remoteDebuggingPolicy() {
  const keys = [
    String.raw`HKLM\SOFTWARE\Policies\Google\Chrome`,
    String.raw`HKCU\SOFTWARE\Policies\Google\Chrome`,
    String.raw`HKLM\SOFTWARE\Policies\Microsoft\Edge`,
    String.raw`HKCU\SOFTWARE\Policies\Microsoft\Edge`,
  ];
  for (const key of keys) {
    const result = spawnSync(
      "reg.exe",
      ["query", key, "/v", "RemoteDebuggingAllowed"],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) continue;
    if (/RemoteDebuggingAllowed\s+REG_DWORD\s+0x0/iu.test(result.stdout)) {
      return "BLOCKED" as const;
    }
    return "ALLOWED" as const;
  }
  return "NOT_CONFIGURED" as const;
}

function executableCandidates(chromium: BrowserType) {
  const configured = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  const localAppData = process.env.LOCALAPPDATA;
  return [
    configured,
    chromium.executablePath(),
    process.env.PROGRAMFILES
      ? path.join(
          process.env.PROGRAMFILES,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : undefined,
    process.env["PROGRAMFILES(X86)"]
      ? path.join(
          process.env["PROGRAMFILES(X86)"],
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        )
      : undefined,
    localAppData
      ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function resolveExecutable(chromium: BrowserType) {
  const executable = executableCandidates(chromium).find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!executable) {
    throw new Error(
      "未找到可用的 Chromium/Chrome，请检查 Playwright 浏览器或 PLAYWRIGHT_EXECUTABLE_PATH。",
    );
  }
  return executable;
}

async function readDevToolsEndpoint(profilePath: string) {
  const value = await readFile(
    path.join(profilePath, DEVTOOLS_ACTIVE_PORT),
    "utf8",
  );
  const [port] = value.trim().split(/\r?\n/u);
  if (!/^\d+$/u.test(port || "")) throw new Error("DevToolsActivePort 无效");
  return `http://127.0.0.1:${port}`;
}

async function connectExisting(
  chromium: BrowserType,
  profilePath: string,
  timeout = 2_000,
) {
  try {
    const endpoint = await readDevToolsEndpoint(profilePath);
    const browser = await chromium.connectOverCDP(endpoint, { timeout });
    if (!browser.isConnected() || !browser.contexts()[0]) {
      await settleWithin(
        browser.close().catch(() => undefined),
        CLOSE_STEP_TIMEOUT_MS,
      );
      return null;
    }
    await browser.version();
    return browser;
  } catch {
    return null;
  }
}

async function waitForConnection(
  chromium: BrowserType,
  profilePath: string,
  child: ChildProcess,
  stderr: () => string,
) {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Chromium 启动失败（退出码 ${child.exitCode}）：${stderr() || "无错误输出"}`,
      );
    }
    const browser = await connectExisting(chromium, profilePath, 500);
    if (browser) return browser;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Chromium 启动超时：${stderr() || "未生成 DevToolsActivePort"}`);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number) {
  let cancelTimeout: () => void = () => undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    cancelTimeout = () => clearTimeout(timeout);
  });
  try {
    return await Promise.race<T | undefined>([promise, timeoutPromise]);
  } finally {
    cancelTimeout();
  }
}

function childProcessRunning(child: ChildProcess) {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForChildProcessExit(child: ChildProcess) {
  if (!childProcessRunning(child)) return true;
  return new Promise<boolean>((resolve) => {
    const finish = () => {
      child.off("exit", finish);
      clearTimeout(timeout);
      resolve(!childProcessRunning(child));
    };
    child.once("exit", finish);
    const timeout = setTimeout(finish, PROCESS_EXIT_TIMEOUT_MS);
  });
}

async function terminateOwnedProcess(child: ChildProcess) {
  if (childProcessRunning(child)) {
    // ChildProcess.kill uses the process handle retained by spawn on Windows;
    // never reopen a PID via taskkill after the original child may have exited.
    // Captured exact-profile descendants are handled by the physical fence.
    child.kill();
  }
  if (!(await waitForChildProcessExit(child))) {
    throw new Error("Chromium 进程树强制终止后仍未在限定时间内退出");
  }
}

async function ensureOwnedProcessStopped(child: ChildProcess) {
  if (await waitForChildProcessExit(child)) return;
  await terminateOwnedProcess(child);
}

async function waitForBrowserDisconnected(browser: Browser) {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
  while (browser.isConnected() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PROFILE_RELEASE_INTERVAL_MS));
  }
  if (browser.isConnected()) {
    throw new Error("Chromium 关闭后连接仍未在限定时间内断开");
  }
}

async function waitForProfileRelease(
  profilePath: string,
  executablePath: string,
  capturedOwners: WindowsBrowserProcessIdentity[],
) {
  await releaseWindowsBrowserProfileOwners(executablePath, profilePath, capturedOwners);
  const activePortPath = path.join(profilePath, DEVTOOLS_ACTIVE_PORT);
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROFILE_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await rm(activePortPath, { force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < PROFILE_RELEASE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, PROFILE_RELEASE_INTERVAL_MS));
      }
    }
  }
  throw new Error(
    `Chromium Profile 锁未在限定次数内释放：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function closeBrowser(
  browser: Browser,
  ownedProcess: ChildProcess | null,
  profilePath: string,
  executablePath: string,
  capturedOwners: WindowsBrowserProcessIdentity[],
  refreshOwners = true,
) {
  // Snapshot growth while the captured root is still live. New orphaned
  // children observed only after its exit never gain termination authority.
  if (refreshOwners) capturedOwners = authorizeWindowsBrowserDescendants(
    await captureWindowsBrowserProfileOwners(executablePath, profilePath), capturedOwners,
  );
  let acceptingSession = true;
  const sessionPromise = browser.newBrowserCDPSession().catch(() => null);
  void sessionPromise.then(lateSession => {
    if (!acceptingSession && lateSession) {
      return settleWithin(lateSession.detach().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS);
    }
  }).catch(() => undefined);
  const session = await settleWithin(
    sessionPromise,
    CLOSE_STEP_TIMEOUT_MS,
  );
  acceptingSession = false;
  if (session) {
    await settleWithin(
      session.send("Browser.close").catch(() => undefined),
      CLOSE_STEP_TIMEOUT_MS,
    );
    await settleWithin(
      session.detach().catch(() => undefined),
      CLOSE_STEP_TIMEOUT_MS,
    );
  }
  await settleWithin(
    browser.close().catch(() => undefined),
    CLOSE_STEP_TIMEOUT_MS,
  );
  if (ownedProcess) await ensureOwnedProcessStopped(ownedProcess);
  // A protocol disconnect does not prove that the physical Profile is free.
  await waitForProfileRelease(profilePath, executablePath, capturedOwners);
  await waitForBrowserDisconnected(browser);
}

async function closePlaywrightPersistentContext(
  context: BrowserContext,
  browser: Browser,
  profilePath: string,
  executablePath: string,
  capturedOwners: WindowsBrowserProcessIdentity[],
) {
  // launchPersistentContext owns the profile through the context. Closing only
  // Browser can disconnect Playwright before Chromium has released that
  // profile, allowing the next runner generation to race the old process.
  try {
    capturedOwners = authorizeWindowsBrowserDescendants(
      await captureWindowsBrowserProfileOwners(executablePath, profilePath), capturedOwners,
    );
  } catch (error) {
    await settleWithin(context.close().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS);
    throw error;
  }
  await settleWithin(context.close().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS);
  await closeBrowser(browser, null, profilePath, executablePath, capturedOwners, false);
}

function closeOnce(operation: () => Promise<void>) {
  let closing: Promise<void> | undefined;
  return () => closing ??= operation();
}

export async function launchWindowsHiddenChromium(
  chromium: BrowserType,
  profilePath: string,
  onDiagnostic?: (snapshot: HiddenChromiumLaunchDiagnostic) => void,
): Promise<HiddenChromiumConnection> {
  const startedAt = Date.now();
  const diagnostic = (phase: string, details: {
    processId?: number;
    exitCode?: number | null;
    stderrBytes?: number;
  } = {}) => {
    // Observability must never change launch, fallback, or cleanup semantics.
    try {
      onDiagnostic?.({
        phase, occurredAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt, ...details,
      });
    } catch { /* diagnostic consumers are non-authoritative */ }
  };
  diagnostic("POLICY_CHECK_START");
  const policy = remoteDebuggingPolicy();
  diagnostic("POLICY_CHECK_END");
  if (policy === "BLOCKED") {
    throw new Error(
      "当前电脑策略限制了浏览器自动控制，请联系管理员检查 RemoteDebuggingAllowed 策略。",
    );
  }
  diagnostic("EXISTING_CDP_CONNECT_START");
  const existing = await connectExisting(chromium, profilePath);
  diagnostic("EXISTING_CDP_CONNECT_END");
  if (existing) {
    const context = existing.contexts()[0];
    if (!context) throw new Error("专用 Chromium 未返回默认 Persistent Context");
    const executablePath = resolveExecutable(chromium);
    diagnostic("PHYSICAL_OWNER_CAPTURE_START");
    let capturedOwners: WindowsBrowserProcessIdentity[];
    try { capturedOwners = authorizeInitialWindowsBrowserOwners(await captureWindowsBrowserProfileOwners(executablePath, profilePath)); }
    catch (error) {
      await settleWithin(existing.close().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS);
      throw error;
    }
    diagnostic("PHYSICAL_OWNER_CAPTURE_END");
    if (!capturedOwners.length) throw new WindowsBrowserProfileOwnershipError("未能验证专用 Chromium 的物理 Profile 所有者");
    return {
      browser: existing,
      context,
      processId: null,
      reusedProcess: true,
      executablePath,
      browserVersion: existing.version(),
      remoteDebuggingMode: "port",
      remoteDebuggingPolicy: policy,
      close: closeOnce(() => closeBrowser(existing, null, profilePath, executablePath, capturedOwners)),
    };
  }

  await mkdir(profilePath, { recursive: true });
  await rm(path.join(profilePath, DEVTOOLS_ACTIVE_PORT), { force: true }).catch(
    () => undefined,
  );
  const executable = resolveExecutable(chromium);
  const args = [
    `--user-data-dir=${profilePath}`,
    "--remote-debugging-port=0",
    "--no-startup-window",
    "--start-minimized",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--lang=zh-CN",
  ];
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  diagnostic("DIRECT_PROCESS_SPAWNED", { processId: child.pid });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  diagnostic("DIRECT_CDP_CONNECT_START");
  const browser = await waitForConnection(
    chromium,
    profilePath,
    child,
    () => stderr.trim(),
  ).catch(async (directLaunchError) => {
    diagnostic("DIRECT_CDP_CONNECT_FAILED", {
      processId: child.pid,
      exitCode: child.exitCode,
      stderrBytes: Buffer.byteLength(stderr, "utf8"),
    });
    await terminateOwnedProcess(child);
    await waitForProfileRelease(profilePath, executable, []);
    diagnostic("DIRECT_PROCESS_AND_PROFILE_RELEASED");
    try {
      diagnostic("PLAYWRIGHT_FALLBACK_LAUNCH_START");
      const context = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        executablePath: executable,
        args: ["--start-minimized"],
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1440, height: 960 },
        timeout: CONNECT_TIMEOUT_MS,
      });
      diagnostic("PLAYWRIGHT_FALLBACK_LAUNCH_END");
      const fallbackBrowser = context.browser();
      if (!fallbackBrowser) {
        await settleWithin(
          context.close().catch(() => undefined),
          CLOSE_STEP_TIMEOUT_MS,
        );
        throw new Error("Playwright Persistent Context 未返回 Browser");
      }
      let capturedOwners: WindowsBrowserProcessIdentity[];
      diagnostic("PHYSICAL_OWNER_CAPTURE_START");
      try { capturedOwners = authorizeInitialWindowsBrowserOwners(await captureWindowsBrowserProfileOwners(executable, profilePath)); }
      catch (error) {
        await settleWithin(context.close().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS);
        throw error;
      }
      diagnostic("PHYSICAL_OWNER_CAPTURE_END");
      if (!capturedOwners.length) {
        await settleWithin(context.close().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS);
        throw new WindowsBrowserProfileOwnershipError("未能验证 Playwright Persistent Context 的物理 Profile 所有者");
      }
      return {
        fallback: true as const,
        browser: fallbackBrowser,
        context,
        directLaunchError,
        capturedOwners,
      };
    } catch (fallbackError) {
      if (fallbackError instanceof WindowsBrowserProfileOwnershipError) throw fallbackError;
      const directMessage = directLaunchError instanceof Error
        ? directLaunchError.message
        : String(directLaunchError);
      const fallbackMessage = fallbackError instanceof Error
        ? fallbackError.message
        : String(fallbackError);
      throw new Error(
        `Chromium 直接启动与 Playwright 回退均失败：${directMessage}；${fallbackMessage}`,
      );
    }
  });
  diagnostic("BROWSER_CONNECTION_READY");
  if ("fallback" in browser) {
    return {
      browser: browser.browser,
      context: browser.context,
      processId: null,
      reusedProcess: false,
      executablePath: executable,
      browserVersion: browser.browser.version(),
      remoteDebuggingMode: "playwright",
      remoteDebuggingPolicy: policy,
      close: closeOnce(() =>
        closePlaywrightPersistentContext(
          browser.context,
          browser.browser,
          profilePath,
          executable,
          browser.capturedOwners,
        )),
    };
  }
  const context = browser.contexts()[0];
  let capturedOwners: WindowsBrowserProcessIdentity[];
  diagnostic("PHYSICAL_OWNER_CAPTURE_START");
  try { capturedOwners = authorizeInitialWindowsBrowserOwners(await captureWindowsBrowserProfileOwners(executable, profilePath), child.pid); }
  catch (error) {
    await settleWithin(browser.close().catch(() => undefined), CLOSE_STEP_TIMEOUT_MS);
    await terminateOwnedProcess(child);
    throw error;
  }
  diagnostic("PHYSICAL_OWNER_CAPTURE_END");
  if (!capturedOwners.some(owner => owner.pid === child.pid)) {
    await terminateOwnedProcess(child);
    throw new WindowsBrowserProfileOwnershipError("Chromium 物理 Profile 所有者与启动进程不一致");
  }
  if (!context) {
    await closeBrowser(browser, child, profilePath, executable, capturedOwners);
    throw new Error("专用 Chromium 未返回默认 Persistent Context");
  }
  const terminateOwnedProcessOnExit = () => {
    if (childProcessRunning(child)) child.kill();
  };
  process.once("exit", terminateOwnedProcessOnExit);
  const close = closeOnce(async () => {
    process.off("exit", terminateOwnedProcessOnExit);
    await closeBrowser(browser, child, profilePath, executable, capturedOwners);
  });
  return {
    browser,
    context,
    processId: child.pid ?? null,
    reusedProcess: false,
    executablePath: executable,
    browserVersion: browser.version(),
    remoteDebuggingMode: "port",
    remoteDebuggingPolicy: policy,
    close,
  };
}

export async function createAuditPage(context: BrowserContext) {
  return context.newPage();
}

export function controlledPageCount(context: BrowserContext | undefined) {
  return (
    context
      ?.pages()
      .filter((page) => !page.isClosed() && page.url() !== "about:blank")
      .length || 0
  );
}
