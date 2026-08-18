import "server-only";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, BrowserType } from "playwright";

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
    if (process.platform === "win32" && child.pid) {
      spawnSync(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        { windowsHide: true, stdio: "ignore", timeout: PROCESS_EXIT_TIMEOUT_MS },
      );
    } else {
      child.kill();
    }
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

async function waitForProfileRelease(profilePath: string) {
  const activePortPath = path.join(profilePath, DEVTOOLS_ACTIVE_PORT);
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROFILE_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await rm(activePortPath, { force: true });
      await new Promise((resolve) => setTimeout(resolve, PROFILE_RELEASE_INTERVAL_MS));
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
) {
  const session = await settleWithin(
    browser.newBrowserCDPSession().catch(() => null),
    CLOSE_STEP_TIMEOUT_MS,
  );
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
  else await waitForBrowserDisconnected(browser);
  await waitForProfileRelease(profilePath);
}

export async function launchWindowsHiddenChromium(
  chromium: BrowserType,
  profilePath: string,
): Promise<HiddenChromiumConnection> {
  const policy = remoteDebuggingPolicy();
  if (policy === "BLOCKED") {
    throw new Error(
      "当前电脑策略限制了浏览器自动控制，请联系管理员检查 RemoteDebuggingAllowed 策略。",
    );
  }
  const existing = await connectExisting(chromium, profilePath);
  if (existing) {
    const context = existing.contexts()[0];
    if (!context) throw new Error("专用 Chromium 未返回默认 Persistent Context");
    return {
      browser: existing,
      context,
      processId: null,
      reusedProcess: true,
      executablePath: resolveExecutable(chromium),
      browserVersion: existing.version(),
      remoteDebuggingMode: "port",
      remoteDebuggingPolicy: policy,
      close: () => closeBrowser(existing, null, profilePath),
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
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const browser = await waitForConnection(
    chromium,
    profilePath,
    child,
    () => stderr.trim(),
  ).catch(async (directLaunchError) => {
    await terminateOwnedProcess(child);
    await waitForProfileRelease(profilePath);
    try {
      const context = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        executablePath: executable,
        args: ["--start-minimized"],
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1440, height: 960 },
        timeout: CONNECT_TIMEOUT_MS,
      });
      const fallbackBrowser = context.browser();
      if (!fallbackBrowser) {
        await settleWithin(
          context.close().catch(() => undefined),
          CLOSE_STEP_TIMEOUT_MS,
        );
        throw new Error("Playwright Persistent Context 未返回 Browser");
      }
      return {
        fallback: true as const,
        browser: fallbackBrowser,
        context,
        directLaunchError,
      };
    } catch (fallbackError) {
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
      close: () => closeBrowser(browser.browser, null, profilePath),
    };
  }
  const context = browser.contexts()[0];
  if (!context) {
    await closeBrowser(browser, child, profilePath);
    throw new Error("专用 Chromium 未返回默认 Persistent Context");
  }
  const terminateOwnedProcessOnExit = () => {
    if (childProcessRunning(child)) child.kill();
  };
  process.once("exit", terminateOwnedProcessOnExit);
  const close = async () => {
    process.off("exit", terminateOwnedProcessOnExit);
    await closeBrowser(browser, child, profilePath);
  };
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
