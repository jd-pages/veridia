import "server-only";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, BrowserType } from "playwright";

const DEVTOOLS_ACTIVE_PORT = "DevToolsActivePort";
const CONNECT_TIMEOUT_MS = 30_000;

type HiddenChromiumConnection = {
  browser: Browser;
  context: BrowserContext;
  processId: number | null;
  reusedProcess: boolean;
  executablePath: string;
  browserVersion: string;
  remoteDebuggingMode: "port";
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
      await browser.close().catch(() => undefined);
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

async function closeBrowser(
  browser: Browser,
  ownedProcess: ChildProcess | null,
) {
  const session = await browser.newBrowserCDPSession().catch(() => null);
  if (session) {
    await session.send("Browser.close").catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (ownedProcess && ownedProcess.exitCode === null) {
    ownedProcess.kill();
  }
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
      close: () => closeBrowser(existing, null),
    };
  }

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
  ).catch((error) => {
    if (child.exitCode === null) child.kill();
    throw error;
  });
  const context = browser.contexts()[0];
  if (!context) {
    await closeBrowser(browser, child);
    throw new Error("专用 Chromium 未返回默认 Persistent Context");
  }
  const terminateOwnedProcess = () => {
    if (child.exitCode === null) child.kill();
  };
  process.once("exit", terminateOwnedProcess);
  const close = async () => {
    process.off("exit", terminateOwnedProcess);
    await closeBrowser(browser, child);
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
