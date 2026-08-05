import "server-only";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { prisma } from "@/lib/db";
import { classifyAutomaticPage } from "./page-classification";

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
  context?: BrowserContext;
  loginPage?: Page;
  launchPromise?: Promise<BrowserContext>;
  sessionState: XhsSessionState;
  lastCheckedAt?: Date;
  lastVerificationAt?: Date;
  lastInvalidReason?: string;
  profileLocked: boolean;
  auditLock?: AuditLock;
};

const globalForAutomation = globalThis as typeof globalThis & {
  xhsBrowserManagerState?: XhsBrowserState;
};

const state =
  globalForAutomation.xhsBrowserManagerState ??
  (globalForAutomation.xhsBrowserManagerState = {
    sessionState: "UNKNOWN",
    profileLocked: false,
  });

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

async function ensureBrowserContext() {
  if (state.context) return state.context;
  if (state.launchPromise) return state.launchPromise;
  await getAutomationSession();
  state.launchPromise = chromium
    .launchPersistentContext(PROFILE_DIRECTORY, persistentOptions())
    .then((context) => {
      state.context = context;
      state.profileLocked = false;
      context.once("close", () => {
        state.context = undefined;
        state.loginPage = undefined;
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

export async function getWorkerBrowserContext() {
  return ensureBrowserContext();
}

export async function closeXhsBrowserContext() {
  const context = state.context;
  state.context = undefined;
  state.loginPage = undefined;
  if (context) await context.close().catch(() => undefined);
}

function livingPage(page: Page | undefined) {
  return page && !page.isClosed() ? page : undefined;
}

async function sessionCheckPage(preferredPage?: Page) {
  const context = await ensureBrowserContext();
  return (
    livingPage(preferredPage) ||
    livingPage(state.loginPage) ||
    context.pages().find((page) => !page.isClosed()) ||
    (await context.newPage())
  );
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
  const context = await ensureBrowserContext();
  const existingPage = livingPage(state.loginPage);
  if (existingPage) {
    await existingPage.bringToFront();
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
  await state.loginPage.bringToFront();
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
  // 只关闭登录 Page，不关闭 persistent context 和 Profile。
  if (state.sessionState === "LOGGED_IN") await page.close().catch(() => undefined);
  return getXhsSessionDiagnostics();
}

export async function restartXhsBrowser() {
  await closeXhsBrowserContext();
  await ensureBrowserContext();
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

export async function getXhsSessionDiagnostics() {
  const session = await getAutomationSession();
  return {
    ...session,
    sessionState: state.sessionState,
    profilePath: PROFILE_DIRECTORY,
    partition: "Playwright persistent context",
    browserRunning: Boolean(state.context),
    pageCount: state.context?.pages().filter((page) => !page.isClosed()).length || 0,
    lastCheckedAt: state.lastCheckedAt?.toISOString() || session.lastCheckedAt,
    lastVerificationAt: state.lastVerificationAt?.toISOString() || null,
    lastInvalidReason: state.lastInvalidReason || session.lastError,
    profileLocked: state.profileLocked,
    currentAuditTaskId: state.auditLock?.taskId || null,
    auditLock: state.auditLock || null,
  };
}
