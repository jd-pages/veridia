import "server-only";
import os from "node:os";
import path from "node:path";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  CDPSession,
  Page,
} from "playwright";
import { prisma } from "@/lib/db";
import { classifyAutomaticPage } from "./page-classification";
import {
  createHiddenAuditPage,
  launchWindowsHiddenChromium,
  pageHasUiWindow,
} from "./windows-hidden-chromium";

const SESSION_ID = "xiaohongshu";
const DEFAULT_PROFILE_DIRECTORY = path.join(
  process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(),
  "VERIDIA",
  "sessions",
  "xiaohongshu-profile",
);
const PROFILE_DIRECTORY = path.resolve(
  /* turbopackIgnore: true */
  process.env.XHS_PROFILE_PATH || DEFAULT_PROFILE_DIRECTORY,
);

export type XhsSessionState =
  | "LOGGED_IN"
  | "LOGGED_OUT"
  | "SECURITY_RESTRICTED"
  | "SESSION_CHECKING"
  | "NETWORK_ERROR"
  | "UNKNOWN";

type AuditLock = {
  batchId: string;
  taskId: string | null;
  startedAt: string;
  heartbeatAt: string;
  status: string;
  profilePath: string;
};

type XhsBrowserState = {
  browser?: Browser;
  context?: BrowserContext;
  closeBrowser?: () => Promise<void>;
  browserProcessId?: number | null;
  reusedBrowserProcess?: boolean;
  auditPage?: Page;
  auditTargetSession?: CDPSession;
  auditPagePromise?: Promise<Page>;
  loginPage?: Page;
  launchPromise?: Promise<BrowserContext>;
  sessionState: XhsSessionState;
  lastCheckedAt?: Date;
  lastVerificationAt?: Date;
  lastInvalidReason?: string;
  profileLocked: boolean;
  auditLock?: AuditLock;
  closingContext: boolean;
  contextClosedUnexpectedly: boolean;
  contextLaunchCount: number;
  auditPageCreateCount: number;
  auditPageReuseCount: number;
  auditPageRequestCount: number;
};

const globalForAutomation = globalThis as typeof globalThis & {
  xhsBrowserManagerState?: XhsBrowserState;
};

const state =
  globalForAutomation.xhsBrowserManagerState ??
  (globalForAutomation.xhsBrowserManagerState = {
    sessionState: "UNKNOWN",
    profileLocked: false,
    closingContext: false,
    contextClosedUnexpectedly: false,
    contextLaunchCount: 0,
    auditPageCreateCount: 0,
    auditPageReuseCount: 0,
    auditPageRequestCount: 0,
  });
state.closingContext ??= false;
state.contextClosedUnexpectedly ??= false;
state.contextLaunchCount ??= 0;
state.auditPageCreateCount ??= 0;
state.auditPageReuseCount ??= 0;
state.auditPageRequestCount ??= 0;

function persistentOptions() {
  const channel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim();
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  return {
    // 登录、人工安全验证和自动审核必须属于同一个可见 persistent context。
    headless: false,
    ...(channel ? { channel } : {}),
    ...(executablePath ? { executablePath } : {}),
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 960 },
  };
}

let chromiumPromise: Promise<BrowserType> | undefined;

function getChromium() {
  if (!chromiumPromise) {
    // 隐藏 CDP Target 在 Chromium 中属于 other target；必须在加载 Playwright 前启用。
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
    chromiumPromise = import("playwright").then((module) => module.chromium);
  }
  return chromiumPromise;
}

function safeDiagnosticUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.slice(0, 200);
  }
}

async function chromiumWindowState(page: Page) {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const result = await session.send("Browser.getWindowForTarget");
      return result.bounds.windowState || "normal";
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    return "unknown";
  }
}

async function setChromiumWindowState(
  page: Page,
  windowState: "minimized" | "normal",
) {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState },
      });
      return true;
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch (error) {
    console.warn(
      "[小红书浏览器] 调整窗口状态失败",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function isProfileLockError(error: unknown) {
  return /profile.*(?:lock|in use)|process_singleton|singletonlock|user data directory.*in use/iu.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function persistSessionState(
  sessionState: XhsSessionState,
  message?: string | null,
  markLogin = false,
) {
  state.sessionState = sessionState;
  state.lastCheckedAt = new Date();
  if (sessionState === "SECURITY_RESTRICTED") {
    state.lastVerificationAt = state.lastCheckedAt;
  }
  if (message) state.lastInvalidReason = message;
  if (sessionState === "LOGGED_IN") state.lastInvalidReason = undefined;
  const status = {
    LOGGED_IN: "READY",
    LOGGED_OUT: "LOGIN_REQUIRED",
    SECURITY_RESTRICTED: "SECURITY_CHECK",
    SESSION_CHECKING: "CHECKING",
    NETWORK_ERROR: "NETWORK_ERROR",
    UNKNOWN: "UNKNOWN",
  }[sessionState];
  return prisma.automationSession.upsert({
    where: { id: SESSION_ID },
    create: {
      id: SESSION_ID,
      platform: "XIAOHONGSHU",
      status,
      profilePath: PROFILE_DIRECTORY,
      lastCheckedAt: state.lastCheckedAt,
      lastLoginAt: markLogin ? state.lastCheckedAt : null,
      lastError: message || null,
    },
    update: {
      status,
      profilePath: PROFILE_DIRECTORY,
      lastCheckedAt: state.lastCheckedAt,
      ...(markLogin ? { lastLoginAt: state.lastCheckedAt } : {}),
      lastError: message || null,
    },
  });
}

export async function getAutomationSession() {
  return prisma.automationSession.upsert({
    where: { id: SESSION_ID },
    create: {
      id: SESSION_ID,
      platform: "XIAOHONGSHU",
      status: "UNKNOWN",
      profilePath: PROFILE_DIRECTORY,
    },
    update: { profilePath: PROFILE_DIRECTORY },
  });
}

async function ensureBrowserContext(allowRelaunch = false) {
  if (state.context) return state.context;
  if (state.launchPromise) return state.launchPromise;
  if (state.contextClosedUnexpectedly && !allowRelaunch) {
    throw new Error(
      "小红书专用浏览器已关闭，审核任务已暂停。请重新打开浏览器后继续审核。",
    );
  }
  await getAutomationSession();
  const launchStartedAt = new Date();
  console.info(
    "[小红书浏览器] 启动 Persistent Context",
    JSON.stringify({
      startedAt: launchStartedAt.toISOString(),
      profilePath: PROFILE_DIRECTORY,
      browserInstanceCount: 0,
    }),
  );
  state.launchPromise = (async () => {
    const chromium = await getChromium();
    if (process.platform === "win32") {
      const connection = await launchWindowsHiddenChromium(
        chromium,
        PROFILE_DIRECTORY,
      );
      state.browser = connection.browser;
      state.closeBrowser = connection.close;
      state.browserProcessId = connection.processId;
      state.reusedBrowserProcess = connection.reusedProcess;
      return connection.context;
    }
    const context = await chromium.launchPersistentContext(
      PROFILE_DIRECTORY,
      persistentOptions(),
    );
    state.browser = context.browser() || undefined;
    state.closeBrowser = () => context.close();
    state.browserProcessId = null;
    state.reusedBrowserProcess = false;
    return context;
  })()
    .then((context) => {
      state.context = context;
      state.profileLocked = false;
      state.contextClosedUnexpectedly = false;
      state.contextLaunchCount += 1;
      console.info(
        "[小红书浏览器] Persistent Context 已就绪",
        JSON.stringify({
          startedAt: launchStartedAt.toISOString(),
          readyAt: new Date().toISOString(),
          browserInstanceCount: 1,
          browserProcessId: state.browserProcessId ?? null,
          reusedBrowserProcess: state.reusedBrowserProcess ?? false,
          contextLaunchCount: state.contextLaunchCount,
          pageCount: context.pages().length,
        }),
      );
      context.once("close", () => {
        const unexpected = !state.closingContext;
        state.context = undefined;
        state.browser = undefined;
        state.closeBrowser = undefined;
        state.browserProcessId = null;
        state.auditPage = undefined;
        state.auditTargetSession = undefined;
        state.auditPagePromise = undefined;
        state.loginPage = undefined;
        state.contextClosedUnexpectedly = unexpected;
        console.warn(
          "[小红书浏览器] Persistent Context 已关闭",
          JSON.stringify({
            closedAt: new Date().toISOString(),
            unexpected,
            browserInstanceCount: 0,
          }),
        );
        if (unexpected) {
          void persistSessionState(
            "LOGGED_OUT",
            "小红书专用浏览器已关闭，审核任务已暂停。请重新打开浏览器后继续审核。",
          ).catch(() => undefined);
        }
      });
      return context;
    })
    .catch(async (error) => {
      state.profileLocked = isProfileLockError(error);
      const message = state.profileLocked
        ? `小红书 Profile 正被其他浏览器实例占用：${PROFILE_DIRECTORY}`
        : error instanceof Error
          ? error.message
          : "小红书专用浏览器启动失败";
      await persistSessionState("UNKNOWN", message);
      throw new Error(message);
    })
    .finally(() => {
      state.launchPromise = undefined;
    });
  return state.launchPromise;
}

export async function getXhsAuditPage(input?: {
  taskId?: string;
  url?: string;
}) {
  state.auditPageRequestCount += 1;
  const existing = livingPage(state.auditPage);
  if (existing) {
    state.auditPageReuseCount += 1;
    console.info(
      "[小红书浏览器] 复用自动审核页面",
      JSON.stringify({
        taskId: input?.taskId || null,
        currentUrl: input?.url ? safeDiagnosticUrl(input.url) : null,
        browserInstanceCount: state.context ? 1 : 0,
        pageCount: state.context?.pages().length || 0,
        auditPageReused: true,
        bringToFrontCalled: false,
        focusCalled: false,
        restoreCalled: false,
      }),
    );
    return existing;
  }
  if (state.auditPagePromise) {
    state.auditPageReuseCount += 1;
    return state.auditPagePromise;
  }

  state.auditPagePromise = (async () => {
    const context = await ensureBrowserContext();
    const pageCountBefore = context.pages().length;
    let page: Page | undefined;
    if (process.platform === "win32") {
      for (const candidate of context.pages()) {
        if (
          candidate.isClosed() ||
          candidate === livingPage(state.loginPage)
        ) {
          continue;
        }
        if (!(await pageHasUiWindow(candidate))) {
          page = candidate;
          break;
        }
        // 应用异常退出后可能遗留人工窗口；自动审核恢复前先关闭专用 Profile 的可见页。
        await candidate.close().catch(() => undefined);
      }
      if (!page) {
        if (!state.browser) throw new Error("专用 Chromium 尚未连接");
        const hiddenPage = await createHiddenAuditPage(state.browser, context);
        page = hiddenPage.page;
        state.auditTargetSession = hiddenPage.keepAliveSession;
      }
    } else {
      page =
        context
          .pages()
          .find(
            (candidate) =>
              !candidate.isClosed() && candidate !== livingPage(state.loginPage),
          ) || (await context.newPage());
    }
    state.auditPage = page;
    state.auditPageCreateCount += 1;
    page.once("close", () => {
      console.warn(
        "[小红书浏览器] 隐藏自动审核页面已关闭",
        JSON.stringify({
          closedAt: new Date().toISOString(),
          browserConnected: state.browser?.isConnected() ?? false,
          contextPageCount: state.context?.pages().length ?? 0,
        }),
      );
      if (state.auditPage === page) {
        state.auditPage = undefined;
        void state.auditTargetSession?.detach().catch(() => undefined);
        state.auditTargetSession = undefined;
      }
      if (state.loginPage === page) state.loginPage = undefined;
    });
    const windowState =
      process.platform === "win32" && !(await pageHasUiWindow(page))
        ? "hidden"
        : await chromiumWindowState(page);
    console.info(
      "[小红书浏览器] 创建自动审核页面",
      JSON.stringify({
        taskId: input?.taskId || null,
        currentUrl: input?.url ? safeDiagnosticUrl(input.url) : null,
        browserInstanceCount: 1,
        pageCountBefore,
        pageCountAfter: context.pages().length,
        auditPageCreateCount: state.auditPageCreateCount,
        auditPageReused: false,
        bringToFrontCalled: false,
        focusCalled: false,
        restoreCalled: false,
        windowState,
      }),
    );
    return page;
  })().finally(() => {
    state.auditPagePromise = undefined;
  });
  return state.auditPagePromise;
}

export async function showXhsManualIntervention(
  page: Page,
  reason: "LOGIN_REQUIRED" | "SECURITY_RESTRICTED" | "USER_REQUESTED",
) {
  let interactivePage = livingPage(state.loginPage);
  if (!interactivePage) {
    const hiddenAuditPage =
      process.platform === "win32" && !(await pageHasUiWindow(page));
    if (hiddenAuditPage) {
      interactivePage = await page.context().newPage();
      if (page.url() !== "about:blank") {
        await interactivePage.goto(page.url(), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      }
    } else {
      interactivePage = page;
    }
    state.loginPage = interactivePage;
    interactivePage.once("close", () => {
      if (state.loginPage === interactivePage) state.loginPage = undefined;
    });
  }
  await setChromiumWindowState(interactivePage, "normal");
  await interactivePage.bringToFront();
  console.info(
    "[小红书浏览器] 显示人工交互页面",
    JSON.stringify({
      reason,
      pageCount: interactivePage.context().pages().length,
      currentUrl: safeDiagnosticUrl(interactivePage.url()),
      bringToFrontCalled: true,
      windowState: await chromiumWindowState(interactivePage),
    }),
  );
}

export async function getXhsAuditPageDiagnostics() {
  const page = livingPage(state.auditPage);
  const interactivePage = livingPage(state.loginPage);
  const windowState = page
    ? process.platform === "win32" && !(await pageHasUiWindow(page))
      ? "hidden"
      : await chromiumWindowState(page)
    : "closed";
  return {
    browserInstanceCount: state.context ? 1 : 0,
    browserProcessId: state.browserProcessId ?? null,
    reusedBrowserProcess: state.reusedBrowserProcess ?? false,
    pageCount: state.context?.pages().filter((item) => !item.isClosed()).length || 0,
    auditPageOpen: Boolean(page),
    auditPageCreateCount: state.auditPageCreateCount,
    auditPageReuseCount: state.auditPageReuseCount,
    auditPageRequestCount: state.auditPageRequestCount,
    auditPageUrl: page ? safeDiagnosticUrl(page.url()) : null,
    interactivePageOpen: Boolean(interactivePage),
    interactivePageIsAuditPage: Boolean(
      page && interactivePage && page === interactivePage,
    ),
    windowState,
  };
}

export async function closeXhsBrowserContext() {
  const context = state.context;
  const closeBrowser = state.closeBrowser;
  state.closingContext = true;
  state.browser = undefined;
  state.context = undefined;
  state.closeBrowser = undefined;
  state.browserProcessId = null;
  state.auditPage = undefined;
  state.auditTargetSession = undefined;
  state.auditPagePromise = undefined;
  state.loginPage = undefined;
  try {
    if (closeBrowser) await closeBrowser().catch(() => undefined);
    else if (context) await context.close().catch(() => undefined);
  } finally {
    state.closingContext = false;
    state.contextClosedUnexpectedly = false;
  }
}

function livingPage(page: Page | undefined) {
  return page && !page.isClosed() ? page : undefined;
}

async function sessionCheckPage(preferredPage?: Page) {
  const context = await ensureBrowserContext();
  const existing =
    livingPage(preferredPage) ||
    livingPage(state.loginPage) ||
    livingPage(state.auditPage) ||
    context.pages().find((page) => !page.isClosed());
  if (existing) return existing;
  if (process.platform === "win32") return getXhsAuditPage();
  return context.newPage();
}

export async function checkXhsSessionState(preferredPage?: Page) {
  await persistSessionState("SESSION_CHECKING");
  const page = await sessionCheckPage(preferredPage);
  try {
    if (!page.url().includes("xiaohongshu.com")) {
      await page.goto("https://www.xiaohongshu.com/explore", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    await page.waitForTimeout(1_200);
    const [title, visibleText, cookies, signedInElementCount] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText({ timeout: 3_000 }).catch(() => ""),
      page.context().cookies(["https://www.xiaohongshu.com"]).catch(() => []),
      page
        .locator(
          "[class*='avatar'], [class*='user-info'], [data-testid*='user'], a[href*='/user/profile']",
        )
        .count()
        .catch(() => 0),
    ]);
    const pageType = classifyAutomaticPage({
      url: page.url(),
      title,
      visibleText,
    });
    if (pageType === "SECURITY_CHECK") {
      await persistSessionState("SECURITY_RESTRICTED", "小红书要求人工完成安全验证");
      return "SECURITY_RESTRICTED" as const;
    }
    if (pageType === "LOGIN") {
      await persistSessionState("LOGGED_OUT", "小红书页面明确要求重新登录");
      return "LOGGED_OUT" as const;
    }
    const cookieNames = new Set(cookies.map((cookie) => cookie.name.toLowerCase()));
    const hasDurableSessionEvidence =
      cookieNames.has("web_session") ||
      signedInElementCount > 0 ||
      (/消息|创作中心|个人主页/u.test(visibleText) && cookies.length >= 2);
    if (hasDurableSessionEvidence) {
      await persistSessionState("LOGGED_IN", null, true);
      return "LOGGED_IN" as const;
    }
    await persistSessionState("UNKNOWN", "页面可访问，但尚无足够证据确认登录状态");
    return "UNKNOWN" as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : "小红书会话检测网络异常";
    await persistSessionState("NETWORK_ERROR", message);
    return "NETWORK_ERROR" as const;
  }
}

export async function startXiaohongshuLogin() {
  state.contextClosedUnexpectedly = false;
  const context = await ensureBrowserContext(true);
  const existingPage = livingPage(state.loginPage);
  if (existingPage) {
    await showXhsManualIntervention(existingPage, "USER_REQUESTED");
    return getXhsSessionDiagnostics();
  }
  state.loginPage = await context.newPage();
  state.loginPage.once("close", () => {
    state.loginPage = undefined;
  });
  await prisma.automationSession.update({
    where: { id: SESSION_ID },
    data: { status: "LOGIN_IN_PROGRESS", lastError: null },
  });
  await state.loginPage.goto("https://www.xiaohongshu.com/explore", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await showXhsManualIntervention(state.loginPage, "USER_REQUESTED");
  return getXhsSessionDiagnostics();
}

export async function completeXiaohongshuLogin() {
  const page = livingPage(state.loginPage);
  if (!page) {
    await persistSessionState("LOGGED_OUT", "专用登录浏览器未打开");
    return getXhsSessionDiagnostics();
  }
  await page.waitForTimeout(1_200);
  await checkXhsSessionState(page);
  // 登录/验证完成后保留自动审核 Page，仅关闭独立人工登录 Page。
  if (state.sessionState === "LOGGED_IN") {
    state.loginPage = undefined;
    if (page === livingPage(state.auditPage)) {
      if (process.platform !== "win32") {
        await setChromiumWindowState(page, "minimized");
      }
    } else {
      await page.close().catch(() => undefined);
      const auditPage = livingPage(state.auditPage);
      if (auditPage && process.platform !== "win32") {
        await setChromiumWindowState(auditPage, "minimized");
      }
    }
  }
  return getXhsSessionDiagnostics();
}

export async function restartXhsBrowser() {
  await closeXhsBrowserContext();
  await ensureBrowserContext(true);
  return getXhsSessionDiagnostics();
}

export async function logoutXhsSession() {
  const context = await ensureBrowserContext();
  await context.clearCookies();
  for (const page of context.pages()) {
    if (page.url().includes("xiaohongshu.com")) {
      await page
        .evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        })
        .catch(() => undefined);
    }
  }
  await persistSessionState("LOGGED_OUT", "用户主动退出小红书登录");
  return getXhsSessionDiagnostics();
}

export async function markXhsSessionIssue(
  sessionState: "LOGGED_OUT" | "SECURITY_RESTRICTED",
  message: string,
) {
  await persistSessionState(sessionState, message);
}

export function updateXhsAuditLock(
  lock: Omit<AuditLock, "heartbeatAt" | "profilePath"> | null,
) {
  state.auditLock = lock
    ? {
        ...lock,
        heartbeatAt: new Date().toISOString(),
        profilePath: PROFILE_DIRECTORY,
      }
    : undefined;
}

export function heartbeatXhsAuditLock(batchId: string, status: string) {
  if (state.auditLock?.batchId !== batchId) return;
  state.auditLock = {
    ...state.auditLock,
    status,
    heartbeatAt: new Date().toISOString(),
  };
}

export function clearXhsAuditLockForBatch(batchId: string) {
  if (state.auditLock?.batchId !== batchId) return false;
  state.auditLock = undefined;
  return true;
}

export async function getXhsSessionDiagnostics() {
  const session = await getAutomationSession();
  const auditPageDiagnostics = await getXhsAuditPageDiagnostics();
  return {
    ...session,
    sessionState: state.sessionState,
    profilePath: PROFILE_DIRECTORY,
    partition: "Playwright persistent context",
    browserRunning: Boolean(state.context),
    lastCheckedAt: state.lastCheckedAt?.toISOString() || session.lastCheckedAt,
    lastVerificationAt: state.lastVerificationAt?.toISOString() || null,
    lastInvalidReason: state.lastInvalidReason || session.lastError,
    profileLocked: state.profileLocked,
    currentAuditTaskId: state.auditLock?.taskId || null,
    auditLock: state.auditLock || null,
    contextClosedUnexpectedly: state.contextClosedUnexpectedly,
    contextLaunchCount: state.contextLaunchCount,
    ...auditPageDiagnostics,
  };
}
