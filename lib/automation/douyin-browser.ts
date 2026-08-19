import "server-only";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright";
import { prisma } from "@/lib/db";
import { classifyDouyinPage } from "./douyin-page-classification";
import {
  controlledPageCount,
  createAuditPage,
  launchWindowsHiddenChromium,
} from "./windows-hidden-chromium";
import { AutomaticExtractionError } from "./failure";

const SESSION_ID = "douyin";
const BROWSER_OPERATION_TIMEOUT_MS = 12_000;
const CDP_OPERATION_TIMEOUT_MS = 3_000;
const PROFILE_DIRECTORY = path.resolve(
  process.env.DOUYIN_PROFILE_PATH ||
    path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(), "VERIDIA", "sessions", "douyin-profile"),
);

export function getDouyinAutomationProfilePath() {
  return PROFILE_DIRECTORY;
}

type DouyinSessionState = "LOGGED_IN" | "LOGGED_OUT" | "SECURITY_RESTRICTED" | "NETWORK_ERROR" | "UNKNOWN";
type AuditLock = { platform: "DOUYIN"; batchId: string; taskId: string | null; startedAt: string; heartbeatAt: string; status: string; profilePath: string };
type State = {
  browser?: Browser;
  context?: BrowserContext;
  closeBrowser?: () => Promise<void>;
  auditPage?: Page;
  auditPagePromise?: Promise<Page>;
  interactivePage?: Page;
  launchPromise?: Promise<BrowserContext>;
  restartPromise?: Promise<void>;
  lifecyclePromise?: Promise<void>;
  sessionState: DouyinSessionState;
  auditLock?: AuditLock;
  launchCount: number;
  auditPageCreateCount: number;
  auditPageReuseCount: number;
  closing: boolean;
  controlError?: string;
  lifecycleGeneration: number;
};
const globalState = globalThis as typeof globalThis & { douyinBrowserManagerState?: State };
const state = globalState.douyinBrowserManagerState ?? (globalState.douyinBrowserManagerState = {
  sessionState: "UNKNOWN",
  launchCount: 0,
  auditPageCreateCount: 0,
  auditPageReuseCount: 0,
  closing: false,
  lifecycleGeneration: 0,
});
state.lifecycleGeneration ??= 0;

let chromiumPromise: Promise<BrowserType> | undefined;
function chromium() {
  chromiumPromise ??= import("playwright").then((module) => module.chromium);
  return chromiumPromise;
}
function living(page?: Page) { return page && !page.isClosed() ? page : undefined; }

async function boundedOperation<T>(
  label: string,
  operation: Promise<T>,
  timeoutMs = BROWSER_OPERATION_TIMEOUT_MS,
) {
  let cancelTimeout: () => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} 超过 ${timeoutMs}ms 确定性上限`)),
      timeoutMs,
    );
    cancelTimeout = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    cancelTimeout();
  }
}

function serializeBrowserLifecycle<T>(operation: () => Promise<T>) {
  const previous = state.lifecyclePromise?.catch(() => undefined) ?? Promise.resolve();
  const result = previous.then(operation);
  const barrier = result.then(() => undefined, () => undefined);
  state.lifecyclePromise = barrier;
  return result.finally(() => {
    if (state.lifecyclePromise === barrier) state.lifecyclePromise = undefined;
  });
}

async function setWindowState(page: Page, windowState: "minimized" | "normal") {
  try {
    const session = await boundedOperation(
      "创建抖音页面 CDP Session",
      page.context().newCDPSession(page),
      CDP_OPERATION_TIMEOUT_MS,
    );
    try {
      const { windowId } = await boundedOperation(
        "读取抖音浏览器窗口",
        session.send("Browser.getWindowForTarget"),
        CDP_OPERATION_TIMEOUT_MS,
      );
      await boundedOperation(
        "设置抖音浏览器窗口",
        session.send("Browser.setWindowBounds", { windowId, bounds: { windowState } }),
        CDP_OPERATION_TIMEOUT_MS,
      );
      return true;
    } finally {
      await boundedOperation(
        "释放抖音页面 CDP Session",
        session.detach().catch(() => undefined),
        CDP_OPERATION_TIMEOUT_MS,
      ).catch(() => undefined);
    }
  } catch { return false; }
}

async function saveSession(status: DouyinSessionState, message?: string | null) {
  state.sessionState = status;
  const mapped = { LOGGED_IN: "READY", LOGGED_OUT: "LOGIN_REQUIRED", SECURITY_RESTRICTED: "SECURITY_CHECK", NETWORK_ERROR: "NETWORK_ERROR", UNKNOWN: "UNKNOWN" }[status];
  return prisma.automationSession.upsert({
    where: { id: SESSION_ID },
    create: { id: SESSION_ID, platform: "DOUYIN", status: mapped, profilePath: PROFILE_DIRECTORY, lastCheckedAt: new Date(), lastError: message || null },
    update: { status: mapped, profilePath: PROFILE_DIRECTORY, lastCheckedAt: new Date(), lastError: message || null },
  });
}

export async function getDouyinAutomationSession() {
  return prisma.automationSession.upsert({
    where: { id: SESSION_ID },
    create: { id: SESSION_ID, platform: "DOUYIN", status: "UNKNOWN", profilePath: PROFILE_DIRECTORY },
    update: { profilePath: PROFILE_DIRECTORY },
  });
}

async function launchContextNow() {
  if (state.context && state.browser?.isConnected()) return state.context;
  const launchGeneration = state.lifecycleGeneration;
  await getDouyinAutomationSession();
  const browserType = await chromium();
  let context: BrowserContext;
  let launchedBrowser: Browser | undefined;
  let closeLaunchedBrowser: (() => Promise<void>) | undefined;
  if (process.platform === "win32") {
    const connection = await launchWindowsHiddenChromium(browserType, PROFILE_DIRECTORY);
    launchedBrowser = connection.browser;
    closeLaunchedBrowser = connection.close;
    context = connection.context;
  } else {
    context = await browserType.launchPersistentContext(PROFILE_DIRECTORY, {
      headless: false,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1440, height: 960 },
      timeout: BROWSER_OPERATION_TIMEOUT_MS,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim() ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH.trim() } : {}),
    });
    launchedBrowser = context.browser() || undefined;
    closeLaunchedBrowser = () => boundedOperation("关闭抖音 Persistent Context", context.close());
  }
  if (launchGeneration !== state.lifecycleGeneration) {
    await (closeLaunchedBrowser?.() || context.close()).catch(() => undefined);
    throw new AutomaticExtractionError(
      "BROWSER_CONTROL_ERROR",
      "抖音浏览器操作已被 Pause 或 extraction deadline 取消",
    );
  }
  state.browser = launchedBrowser;
  state.closeBrowser = closeLaunchedBrowser;
  state.context = context;
  state.launchCount += 1;
  state.controlError = undefined;
  context.once("close", () => {
    if (state.context === context) {
      state.context = undefined;
      state.browser = undefined;
      state.auditPage = undefined;
      state.interactivePage = undefined;
      if (!state.closing) state.controlError = "抖音专用浏览器已关闭";
    }
  });
  console.info("[抖音浏览器] Persistent Context 已就绪", JSON.stringify({ profilePath: path.basename(PROFILE_DIRECTORY), launchCount: state.launchCount, pageCount: context.pages().length }));
  return context;
}

async function ensureContext() {
  if (state.restartPromise) await state.restartPromise;
  if (state.context && state.browser?.isConnected()) return state.context;
  if (state.launchPromise) return state.launchPromise;
  const launch = serializeBrowserLifecycle(launchContextNow);
  const tracked = launch.finally(() => {
    if (state.launchPromise === tracked) state.launchPromise = undefined;
  });
  state.launchPromise = tracked;
  return tracked;
}

async function closeContextNow() {
  state.lifecycleGeneration += 1;
  state.closing = true;
  const close = state.closeBrowser;
  const context = state.context;
  state.context = undefined;
  state.browser = undefined;
  state.auditPage = undefined;
  state.interactivePage = undefined;
  state.closeBrowser = undefined;
  try {
    if (close) await close();
    else if (context) {
      await boundedOperation("关闭抖音 Persistent Context", context.close());
    }
  } finally {
    state.closing = false;
  }
}

export async function getDouyinAuditPage(input?: { taskId?: string; url?: string }) {
  try {
    const existing = living(state.auditPage);
    if (existing && state.context && state.browser?.isConnected()) {
      state.auditPageReuseCount += 1;
      return existing;
    }
    if (state.auditPagePromise) return await state.auditPagePromise;
    state.auditPagePromise = (async () => {
      const context = await ensureContext();
      const page = await createAuditPage(context);
      if (process.platform === "win32") await setWindowState(page, "minimized");
      state.auditPage = page;
      state.auditPageCreateCount += 1;
      page.once("close", () => { if (state.auditPage === page) state.auditPage = undefined; });
      console.info("[抖音浏览器] 创建后台审核页面", JSON.stringify({ taskId: input?.taskId || null, pageCount: context.pages().length, auditPageCreateCount: state.auditPageCreateCount, bringToFrontCalled: false }));
      return page;
    })().finally(() => { state.auditPagePromise = undefined; });
    return await state.auditPagePromise;
  } catch (error) {
    if (error instanceof AutomaticExtractionError) throw error;
    throw new AutomaticExtractionError(
      "BROWSER_CONTROL_ERROR",
      "抖音专用浏览器连接异常，当前批次已暂停。请重新启动专用浏览器后继续。",
      {
        technicalMessage: error instanceof Error
          ? error.message.slice(0, 500)
          : String(error).slice(0, 500),
      },
    );
  }
}

export async function showDouyinManualIntervention(page: Page, reason: string) {
  state.interactivePage = living(state.interactivePage) || page;
  await setWindowState(state.interactivePage, "normal");
  await state.interactivePage.bringToFront();
  console.info("[抖音浏览器] 显示人工交互页面", JSON.stringify({ reason, pageCount: page.context().pages().length }));
}

export async function checkDouyinSessionState(preferredPage?: Page) {
  const context = await ensureContext();
  const page = living(preferredPage) || living(state.interactivePage) || living(state.auditPage) || context.pages().find((candidate) => !candidate.isClosed()) || await getDouyinAuditPage();
  try {
    if (!page.url().includes("douyin.com")) await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const [title, text] = await Promise.all([page.title().catch(() => ""), page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")]);
    const classified = classifyDouyinPage({ url: page.url(), title, visibleText: text });
    if (classified.state === "SECURITY_RESTRICTED") { await saveSession("SECURITY_RESTRICTED", "抖音要求安全验证"); return "SECURITY_RESTRICTED" as const; }
    if (classified.state === "NOT_LOGGED_IN") { await saveSession("LOGGED_OUT", "抖音登录状态失效"); return "LOGGED_OUT" as const; }
    await saveSession("LOGGED_IN");
    if (page !== living(state.interactivePage)) await setWindowState(page, "minimized");
    return "LOGGED_IN" as const;
  } catch (error) {
    await saveSession("NETWORK_ERROR", error instanceof Error ? error.message : "抖音登录检测失败");
    return "NETWORK_ERROR" as const;
  }
}

export async function startDouyinLogin() {
  const page = await getDouyinAuditPage();
  await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
  await showDouyinManualIntervention(page, "LOGIN_REQUIRED");
  return getDouyinSessionDiagnostics();
}
export async function completeDouyinLogin() {
  const interactivePage = living(state.interactivePage);
  const result = await checkDouyinSessionState(interactivePage);
  if (result === "LOGGED_IN" && interactivePage) {
    state.interactivePage = undefined;
    await setWindowState(interactivePage, "minimized");
  }
  return getDouyinSessionDiagnostics();
}
export async function restartDouyinBrowser() {
  if (!state.restartPromise) {
    const restart = serializeBrowserLifecycle(async () => {
      await closeContextNow();
      await launchContextNow();
    });
    const tracked = restart.finally(() => {
      if (state.restartPromise === tracked) state.restartPromise = undefined;
    });
    state.restartPromise = tracked;
  }
  await state.restartPromise;
  return getDouyinSessionDiagnostics();
}
export async function logoutDouyinSession() {
  await serializeBrowserLifecycle(async () => {
    const context = state.context;
    if (context) {
      await boundedOperation("清除抖音 Cookie", context.clearCookies());
      for (const page of context.pages()) {
        await boundedOperation(
          "清除抖音页面存储",
          page.evaluate(() => {
            window.localStorage.clear();
            window.sessionStorage.clear();
          }).catch(() => undefined),
        );
      }
    }
    await closeContextNow();
    await saveSession("LOGGED_OUT", "用户已退出抖音专用浏览器");
  });
  return getDouyinSessionDiagnostics();
}
export async function closeDouyinBrowserContext() {
  await serializeBrowserLifecycle(closeContextNow);
}
export async function cancelDouyinActiveExtraction() {
  state.lifecycleGeneration += 1;
  state.closing = true;
  const close = state.closeBrowser;
  const context = state.context;
  state.context = undefined;
  state.browser = undefined;
  state.auditPage = undefined;
  state.auditPagePromise = undefined;
  state.closeBrowser = undefined;
  try {
    if (close) await close().catch(() => undefined);
    else if (context) {
      await boundedOperation("取消抖音审核浏览器操作", context.close()).catch(
        () => undefined,
      );
    }
  } finally {
    state.closing = false;
  }
}
export async function closeDouyinAuditPageForTesting() {
  await serializeBrowserLifecycle(async () => {
    const page = living(state.auditPage);
    if (page) await boundedOperation("关闭抖音审核页面", page.close());
  });
  return getDouyinSessionDiagnostics();
}
export async function ensureDouyinBrowserControlReady() { try { await ensureContext(); } catch (error) { throw new AutomaticExtractionError("BROWSER_CONTROL_ERROR", "抖音专用浏览器连接异常", { technicalMessage: error instanceof Error ? error.message : String(error) }); } }
export async function markDouyinSessionIssue(status: "LOGIN_EXPIRED" | "SECURITY_RESTRICTED", message: string) { return saveSession(status === "LOGIN_EXPIRED" ? "LOGGED_OUT" : "SECURITY_RESTRICTED", message); }
export function updateDouyinAuditLock(input: Omit<AuditLock, "platform" | "heartbeatAt" | "profilePath"> | null) { state.auditLock = input ? { ...input, platform: "DOUYIN", heartbeatAt: new Date().toISOString(), profilePath: PROFILE_DIRECTORY } : undefined; }
export function heartbeatDouyinAuditLock(batchId: string, status: string) { if (state.auditLock?.batchId !== batchId) return; state.auditLock = { ...state.auditLock, status, heartbeatAt: new Date().toISOString() }; }
export function clearDouyinAuditLockForBatch(batchId: string) { if (state.auditLock?.batchId !== batchId) return false; state.auditLock = undefined; return true; }
export async function getDouyinSessionDiagnostics() {
  const session = await getDouyinAutomationSession();
  return { ...session, platform: "DOUYIN", profilePath: PROFILE_DIRECTORY, sessionState: state.sessionState, browserInstanceCount: state.context ? 1 : 0, pageCount: controlledPageCount(state.context), auditPageOpen: Boolean(living(state.auditPage)), auditPageCreateCount: state.auditPageCreateCount, auditPageReuseCount: state.auditPageReuseCount, interactivePageOpen: Boolean(living(state.interactivePage)), auditLock: state.auditLock || null, controlReady: Boolean(state.context && state.browser?.isConnected()), controlLastError: state.controlError || null };
}
