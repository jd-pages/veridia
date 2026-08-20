import "server-only";
import os from "node:os";
import path from "node:path";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
} from "playwright";
import { prisma } from "@/lib/db";
import packageJson from "@/package.json";
import { classifyAutomaticPage } from "./page-classification";
import {
  controlledPageCount,
  createAuditPage,
  launchWindowsHiddenChromium,
} from "./windows-hidden-chromium";
import {
  AutomaticExtractionError,
  isBrowserControlInfrastructureError,
} from "./failure";
import {
  XhsContextPageArbiter,
  XhsPageInvariantError,
  type XhsPageReconcileReason,
} from "./xhs-page-arbiter";

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

export function getXhsAutomationProfilePath() {
  return PROFILE_DIRECTORY;
}

export type XhsSessionState =
  | "LOGGED_IN"
  | "LOGGED_OUT"
  | "SECURITY_RESTRICTED"
  | "SESSION_CHECKING"
  | "NETWORK_ERROR"
  | "UNKNOWN";

export type XhsBrowserControlState =
  | "NOT_STARTED"
  | "CONNECTING"
  | "READY"
  | "DISCONNECTED"
  | "RESTART_REQUIRED";

type AuditLock = {
  platform: "XIAOHONGSHU";
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
  browserExecutablePath?: string;
  browserVersion?: string;
  remoteDebuggingMode?: "port" | "playwright";
  remoteDebuggingPolicy?: "ALLOWED" | "BLOCKED" | "NOT_CONFIGURED";
  auditPage?: Page;
  auditPagePromise?: Promise<Page>;
  loginPage?: Page;
  interactivePage?: Page;
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
  controlState: XhsBrowserControlState;
  controlLastError?: string;
  controlDisconnectedAt?: Date;
  automaticRecoveryCount: number;
  lifecycleGeneration: number;
  pageArbiter?: XhsContextPageArbiter<Page>;
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
    controlState: "NOT_STARTED",
    automaticRecoveryCount: 0,
    lifecycleGeneration: 0,
  });
state.closingContext ??= false;
state.contextClosedUnexpectedly ??= false;
state.contextLaunchCount ??= 0;
state.auditPageCreateCount ??= 0;
state.auditPageReuseCount ??= 0;
state.auditPageRequestCount ??= 0;
state.controlState ??= "NOT_STARTED";
state.automaticRecoveryCount ??= 0;
state.lifecycleGeneration ??= 0;

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
    chromiumPromise = import("playwright").then((module) => module.chromium);
  }
  return chromiumPromise;
}

function safeDiagnosticUrl(value: string) {
  if (value === "about:blank" || value.startsWith("chrome:")) return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.slice(0, 200);
  }
}

async function e2ePageSummaries() {
  if (process.env.VERIDIA_E2E !== "true") return undefined;
  const auditPage = livingPage(state.auditPage);
  const loginPage = livingPage(state.loginPage);
  const interactivePage = livingPage(state.interactivePage);
  return Promise.all(
    (state.context?.pages() || []).map(async (page, index) => {
      const opener = await page.opener().catch(() => null);
      const metadata = state.pageArbiter?.metadataFor(page);
      return {
        index,
        url: safeDiagnosticUrl(page.url()),
        title: await page.title().catch(() => ""),
        closed: page.isClosed(),
        isAuditPage: page === auditPage,
        isLoginPage: page === loginPage,
        isInteractivePage: page === interactivePage,
        createdAt: metadata?.createdAt || null,
        generation: metadata?.generation ?? null,
        role: metadata?.role || "UNKNOWN",
        roles: metadata?.roles || ["UNKNOWN"],
        source: metadata?.source || "UNKNOWN",
        opener: opener ? safeDiagnosticUrl(opener.url()) : null,
      };
    }),
  );
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

export async function keepXhsAuditPageInBackground(page: Page) {
  if (
    page === livingPage(state.loginPage) ||
    page === livingPage(state.interactivePage)
  ) {
    return false;
  }
  await reconcileCurrentContextPages("POST_NAVIGATION");
  return setChromiumWindowState(page, "minimized");
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

const BROWSER_CONTROL_MESSAGE =
  "审核浏览器连接异常，当前批次已暂停。请点击“重新启动专用浏览器”后继续。";

class XhsPageGenerationInvalidatedError extends AutomaticExtractionError {
  constructor() {
    super(
      "BROWSER_CONTROL_ERROR",
      "小红书浏览器操作已被 Pause 或 extraction deadline 取消",
    );
    this.name = "XhsPageGenerationInvalidatedError";
  }
}

function diagnosticProfilePath() {
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData && PROFILE_DIRECTORY.startsWith(localAppData)
    ? PROFILE_DIRECTORY.replace(localAppData, "%LOCALAPPDATA%")
    : path.basename(PROFILE_DIRECTORY);
}

function browserControlAvailable() {
  return Boolean(
    state.context &&
      state.browser?.isConnected() &&
      !state.contextClosedUnexpectedly,
  );
}

function browserControlError(error?: unknown) {
  const technicalMessage =
    error instanceof Error ? error.message.slice(0, 500) : undefined;
  return new AutomaticExtractionError(
    "BROWSER_CONTROL_ERROR",
    BROWSER_CONTROL_MESSAGE,
    technicalMessage ? { technicalMessage } : undefined,
  );
}

function createContextPageArbiter(
  context: BrowserContext,
  generation: number,
  launchStartedAt: Date,
) {
  state.pageArbiter?.dispose();
  const arbiter = new XhsContextPageArbiter<Page>({
    context,
    generation,
    getOwnedPages: () => ({
      audit: livingPage(state.auditPage),
      interactive: livingPage(state.interactivePage),
      login: livingPage(state.loginPage),
    }),
    isCurrentGeneration: () =>
      state.context === context && state.lifecycleGeneration === generation,
    safeUrl: safeDiagnosticUrl,
    classifyOwnedPopup: (page, opener) => {
      const loginPage = livingPage(state.loginPage);
      const interactivePage = livingPage(state.interactivePage);
      if (opener !== loginPage && opener !== interactivePage) return undefined;
      state.interactivePage = page;
      page.once("close", () => {
        if (state.interactivePage === page) state.interactivePage = undefined;
      });
      return "INTERACTIVE";
    },
    log: (event, details) => {
      console.info(`[小红书浏览器] ${event}`, JSON.stringify(details));
    },
    onAsyncInvariantFailure: async (error) => {
      if (state.context !== context || state.lifecycleGeneration !== generation) {
        return;
      }
      console.error(
        "[小红书浏览器] XHS_PAGE_INVARIANT_FAILED",
        JSON.stringify({
          generation,
          message: error.message.slice(0, 500),
          pageCount: context.pages().filter((page) => !page.isClosed()).length,
        }),
      );
      await closeXhsBrowserContext();
      state.contextClosedUnexpectedly = true;
      state.controlState = "RESTART_REQUIRED";
      state.controlLastError = BROWSER_CONTROL_MESSAGE;
    },
  });
  state.pageArbiter = arbiter;
  arbiter.observeContextPages(launchStartedAt);
  return arbiter;
}

function ensureContextPageArbiter(context: BrowserContext) {
  return (
    state.pageArbiter ||
    createContextPageArbiter(
      context,
      state.lifecycleGeneration,
      new Date(),
    )
  );
}

async function reconcileCurrentContextPages(
  reason: XhsPageReconcileReason,
  settle = true,
) {
  const context = state.context;
  if (!context) throw browserControlError();
  const arbiter = ensureContextPageArbiter(context);
  try {
    const result = settle
      ? await arbiter.settleAndReconcile(reason)
      : await arbiter.reconcile(reason);
    if (!result.active || state.context !== context) {
      throw new XhsPageGenerationInvalidatedError();
    }
    return result;
  } catch (error) {
    if (error instanceof XhsPageGenerationInvalidatedError) throw error;
    if (error instanceof XhsPageInvariantError) throw error;
    throw new XhsPageInvariantError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function ensureBrowserContext(allowRelaunch = false) {
  if (browserControlAvailable()) {
    state.controlState = "READY";
    ensureContextPageArbiter(state.context!);
    return state.context!;
  }
  if (state.context || state.browser) {
    const staleContext = state.context;
    const staleCloseBrowser = state.closeBrowser;
    state.pageArbiter?.dispose();
    state.pageArbiter = undefined;
    state.lifecycleGeneration += 1;
    state.context = undefined;
    state.browser = undefined;
    state.closeBrowser = undefined;
    state.auditPage = undefined;
    state.auditPagePromise = undefined;
    state.loginPage = undefined;
    state.interactivePage = undefined;
    state.controlState = "DISCONNECTED";
    state.controlDisconnectedAt = new Date();
    if (staleCloseBrowser) {
      await staleCloseBrowser().catch(() => undefined);
    } else if (staleContext) {
      await staleContext.close().catch(() => undefined);
    }
  }
  if (state.launchPromise) return state.launchPromise;
  if (state.contextClosedUnexpectedly && !allowRelaunch) {
    throw browserControlError();
  }
  await getAutomationSession();
  const launchStartedAt = new Date();
  const launchGeneration = state.lifecycleGeneration;
  state.controlState = "CONNECTING";
  console.info(
    "[小红书浏览器] 启动 Persistent Context",
    JSON.stringify({
      startedAt: launchStartedAt.toISOString(),
      veridiaVersion: packageJson.version,
      electronVersion: packageJson.devDependencies.electron,
      playwrightVersion: packageJson.devDependencies["@playwright/test"],
      profilePath: diagnosticProfilePath(),
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
      state.browserExecutablePath = connection.executablePath;
      state.browserVersion = connection.browserVersion;
      state.remoteDebuggingMode = connection.remoteDebuggingMode;
      state.remoteDebuggingPolicy = connection.remoteDebuggingPolicy;
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
    state.browserExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    state.browserVersion = state.browser?.version();
    state.remoteDebuggingMode = "playwright";
    return context;
  })()
    .then((context) => {
      if (launchGeneration !== state.lifecycleGeneration) {
        const closeBrowser = state.closeBrowser;
        state.browser = undefined;
        state.context = undefined;
        state.closeBrowser = undefined;
        return (closeBrowser ? closeBrowser() : context.close())
          .catch(() => undefined)
          .then(() => {
            throw new AutomaticExtractionError(
              "BROWSER_CONTROL_ERROR",
              "小红书浏览器操作已被 Pause 或 extraction deadline 取消",
            );
          });
      }
      state.context = context;
      createContextPageArbiter(context, launchGeneration, launchStartedAt);
      state.profileLocked = false;
      state.contextClosedUnexpectedly = false;
      state.controlState = "READY";
      state.controlLastError = undefined;
      state.contextLaunchCount += 1;
      console.info(
        "[小红书浏览器] Persistent Context 已就绪",
        JSON.stringify({
          startedAt: launchStartedAt.toISOString(),
          readyAt: new Date().toISOString(),
          browserInstanceCount: 1,
          browserProcessId: state.browserProcessId ?? null,
          browserVersion: state.browserVersion ?? null,
          browserExecutablePath: state.browserExecutablePath ?? null,
          profilePath: diagnosticProfilePath(),
          isolatedProfile: true,
          remoteDebuggingMode: state.remoteDebuggingMode ?? null,
          remoteDebuggingPolicy: state.remoteDebuggingPolicy ?? null,
          reusedBrowserProcess: state.reusedBrowserProcess ?? false,
          contextLaunchCount: state.contextLaunchCount,
          pageCount: context.pages().length,
        }),
      );
      context.once("close", () => {
        const unexpected = !state.closingContext;
        const currentGeneration =
          state.context === context &&
          state.lifecycleGeneration === launchGeneration;
        if (currentGeneration) {
          state.pageArbiter?.dispose();
          state.pageArbiter = undefined;
          state.context = undefined;
          state.browser = undefined;
          state.closeBrowser = undefined;
          state.browserProcessId = null;
          state.auditPage = undefined;
          state.auditPagePromise = undefined;
          state.loginPage = undefined;
          state.interactivePage = undefined;
          state.contextClosedUnexpectedly = unexpected;
          state.controlState = unexpected ? "DISCONNECTED" : "NOT_STARTED";
          state.controlDisconnectedAt = unexpected ? new Date() : undefined;
        }
        console.warn(
          "[小红书浏览器] Persistent Context 已关闭",
          JSON.stringify({
            closedAt: new Date().toISOString(),
            unexpected,
            browserInstanceCount: 0,
          }),
        );
        if (unexpected && currentGeneration) {
          state.controlLastError = BROWSER_CONTROL_MESSAGE;
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
      state.controlState = "RESTART_REQUIRED";
      state.controlLastError = message;
      throw browserControlError(error);
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
  if (existing && browserControlAvailable()) {
    const reconciled = await reconcileCurrentContextPages("AUDIT_REQUEST");
    if (
      livingPage(state.auditPage) !== existing ||
      reconciled.auditPageCount !== 1 ||
      reconciled.stalePageCount !== 0
    ) {
      throw browserControlError(
        new XhsPageInvariantError("复用 auditPage 前 exclusive invariant 失败"),
      );
    }
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
  if (existing) {
    state.auditPage = undefined;
    state.controlState = "DISCONNECTED";
    state.controlLastError = BROWSER_CONTROL_MESSAGE;
  }
  if (state.auditPagePromise) {
    state.auditPageReuseCount += 1;
    return state.auditPagePromise;
  }

  state.auditPagePromise = (async () => {
    let recoveryAttempt = 0;
    while (true) {
      try {
        const context = await ensureBrowserContext(recoveryAttempt > 0);
        const pageCountBefore = context.pages().length;
        await reconcileCurrentContextPages("CONTEXT_READY");
        const arbiter = ensureContextPageArbiter(context);
        const page = await arbiter.createClaimedPage(
          "AUDIT",
          "AUDIT_CREATE",
          () => createAuditPage(context),
        );
        state.auditPage = page;
        const reconciled = await reconcileCurrentContextPages(
          "AUDIT_PAGE_CREATED",
        );
        if (
          livingPage(state.auditPage) !== page ||
          reconciled.auditPageCount !== 1 ||
          reconciled.stalePageCount !== 0
        ) {
          throw new XhsPageInvariantError(
            "创建 auditPage 后 exclusive invariant 失败",
          );
        }
        if (process.platform === "win32") {
          await setChromiumWindowState(page, "minimized");
        }
        state.auditPageCreateCount += 1;
        state.controlState = "READY";
        state.controlLastError = undefined;
        page.once("close", () => {
          console.warn(
            "[小红书浏览器] 自动审核页面已关闭",
            JSON.stringify({
              closedAt: new Date().toISOString(),
              browserConnected: state.browser?.isConnected() ?? false,
              contextPageCount: state.context?.pages().length ?? 0,
            }),
          );
          if (state.auditPage === page) state.auditPage = undefined;
          if (state.loginPage === page) state.loginPage = undefined;
          if (state.interactivePage === page) {
            state.interactivePage = undefined;
          }
        });
        console.info(
          "[小红书浏览器] 创建标准自动审核页面",
          JSON.stringify({
            taskId: input?.taskId || null,
            currentUrl: input?.url ? safeDiagnosticUrl(input.url) : null,
            browserInstanceCount: 1,
            pageCountBefore,
            pageCountAfter: context.pages().length,
            stalePageCleanupCount: reconciled.closedStalePageCount,
            auditPageCreateCount: state.auditPageCreateCount,
            pageCreationMethod: "browserContext.newPage",
            auditPageReused: false,
            bringToFrontCalled: false,
            focusCalled: false,
            restoreCalled: false,
            windowState: await chromiumWindowState(page),
            automaticRecoveryAttempt: recoveryAttempt,
          }),
        );
        return page;
      } catch (error) {
        if (error instanceof XhsPageGenerationInvalidatedError) throw error;
        const pageInvariantFailure = error instanceof XhsPageInvariantError;
        if (
          (!isBrowserControlInfrastructureError(error) &&
            !pageInvariantFailure) ||
          recoveryAttempt >= 1
        ) {
          state.controlState = "RESTART_REQUIRED";
          state.controlLastError = BROWSER_CONTROL_MESSAGE;
          throw browserControlError(error);
        }
        recoveryAttempt += 1;
        state.automaticRecoveryCount += 1;
        console.warn(
          "[小红书浏览器] 控制连接异常，自动重建一次",
          JSON.stringify({
            occurredAt: new Date().toISOString(),
            stage: "CREATE_AUDIT_PAGE",
            automaticRecoveryAttempt: recoveryAttempt,
          }),
        );
        await closeXhsBrowserContext();
      }
    }
  })().finally(() => {
    state.auditPagePromise = undefined;
  });
  return state.auditPagePromise;
}

export async function showXhsManualIntervention(
  page: Page,
  reason: "LOGIN_REQUIRED" | "SECURITY_RESTRICTED" | "USER_REQUESTED",
) {
  let interactivePage =
    livingPage(state.interactivePage) || livingPage(state.loginPage);
  if (!interactivePage) {
    interactivePage = page;
    interactivePage.once("close", () => {
      if (state.interactivePage === interactivePage) {
        state.interactivePage = undefined;
      }
    });
  }
  state.interactivePage = interactivePage;
  state.pageArbiter?.claimPage(
    interactivePage,
    "INTERACTIVE",
    "INTERACTIVE_CLAIM",
  );
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
  const loginPage = livingPage(state.loginPage);
  const interactivePage = livingPage(state.interactivePage);
  const windowState = page ? await chromiumWindowState(page) : "closed";
  return {
    browserInstanceCount: state.context ? 1 : 0,
    browserProcessId: state.browserProcessId ?? null,
    reusedBrowserProcess: state.reusedBrowserProcess ?? false,
    pageCount: controlledPageCount(state.context),
    auditPageOpen: Boolean(page),
    auditPageCreateCount: state.auditPageCreateCount,
    auditPageReuseCount: state.auditPageReuseCount,
    auditPageRequestCount: state.auditPageRequestCount,
    auditPageUrl: page ? safeDiagnosticUrl(page.url()) : null,
    loginPageOpen: Boolean(loginPage),
    interactivePageOpen: Boolean(interactivePage),
    interactivePageIsAuditPage: Boolean(
      page && interactivePage && page === interactivePage,
    ),
    windowState,
    controlState: state.controlState,
    controlReady: browserControlAvailable(),
    controlLastError: state.controlLastError || null,
    controlDisconnectedAt: state.controlDisconnectedAt?.toISOString() || null,
    browserVersion: state.browserVersion || null,
    browserExecutablePath: state.browserExecutablePath || null,
    remoteDebuggingMode: state.remoteDebuggingMode || null,
    remoteDebuggingPolicy: state.remoteDebuggingPolicy || null,
    automaticRecoveryCount: state.automaticRecoveryCount,
    ...(process.env.VERIDIA_E2E === "true"
      ? { pageSummaries: await e2ePageSummaries() }
      : {}),
  };
}

export async function closeXhsBrowserContext() {
  state.pageArbiter?.dispose();
  state.pageArbiter = undefined;
  state.lifecycleGeneration += 1;
  const context = state.context;
  const closeBrowser = state.closeBrowser;
  state.closingContext = true;
  state.browser = undefined;
  state.context = undefined;
  state.closeBrowser = undefined;
  state.browserProcessId = null;
  state.auditPage = undefined;
  state.auditPagePromise = undefined;
  state.loginPage = undefined;
  state.interactivePage = undefined;
  try {
    if (closeBrowser) await closeBrowser().catch(() => undefined);
    else if (context) await context.close().catch(() => undefined);
  } finally {
    state.closingContext = false;
    state.contextClosedUnexpectedly = false;
    state.controlState = "NOT_STARTED";
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
    livingPage(state.interactivePage) ||
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
  const existingPage =
    livingPage(state.loginPage) || livingPage(state.interactivePage);
  if (existingPage) {
    await showXhsManualIntervention(existingPage, "USER_REQUESTED");
    return getXhsSessionDiagnostics();
  }
  state.loginPage = await ensureContextPageArbiter(context).createClaimedPage(
    "LOGIN",
    "LOGIN_CREATE",
    () => context.newPage(),
  );
  const loginPage = state.loginPage;
  loginPage.once("close", () => {
    if (state.loginPage === loginPage) state.loginPage = undefined;
    if (state.interactivePage === loginPage) {
      state.interactivePage = undefined;
    }
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
  const page =
    livingPage(state.interactivePage) || livingPage(state.loginPage);
  if (!page) {
    await persistSessionState("LOGGED_OUT", "专用登录浏览器未打开");
    return getXhsSessionDiagnostics();
  }
  await page.waitForTimeout(1_200);
  await checkXhsSessionState(page);
  // 登录/验证完成后保留自动审核 Page，仅关闭独立人工登录 Page。
  if (state.sessionState === "LOGGED_IN") {
    const loginPage = livingPage(state.loginPage);
    const interactivePage = livingPage(state.interactivePage);
    state.loginPage = undefined;
    state.interactivePage = undefined;
    if (loginPage) state.pageArbiter?.releasePageRole(loginPage, "LOGIN");
    if (interactivePage) {
      state.pageArbiter?.releasePageRole(interactivePage, "INTERACTIVE");
    }
    if (page === livingPage(state.auditPage)) {
      await setChromiumWindowState(page, "minimized");
    } else {
      for (const manualPage of new Set([page, loginPage, interactivePage])) {
        if (manualPage && manualPage !== livingPage(state.auditPage)) {
          await manualPage.close().catch(() => undefined);
        }
      }
      const auditPage = livingPage(state.auditPage);
      if (auditPage) {
        await setChromiumWindowState(auditPage, "minimized");
      }
    }
  }
  return getXhsSessionDiagnostics();
}

export async function restartXhsBrowser() {
  await closeXhsBrowserContext();
  await ensureBrowserContext(true);
  await getXhsAuditPage();
  return getXhsSessionDiagnostics();
}

export async function closeXhsAuditPageForTesting() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("仅测试环境允许关闭自动审核页面");
  }
  const page = livingPage(state.auditPage);
  if (page) await page.close();
  return getXhsSessionDiagnostics();
}

export async function ensureXhsBrowserControlReady(allowRecovery = true) {
  try {
    const context = await ensureBrowserContext(allowRecovery);
    if (!state.browser?.isConnected() || context !== state.context) {
      throw browserControlError();
    }
    await state.browser.version();
    state.controlState = "READY";
    state.controlLastError = undefined;
    return true;
  } catch (error) {
    if (allowRecovery && isBrowserControlInfrastructureError(error)) {
      await restartXhsBrowser();
      return browserControlAvailable();
    }
    throw browserControlError(error);
  }
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
  lock: Omit<AuditLock, "platform" | "heartbeatAt" | "profilePath"> | null,
) {
  state.auditLock = lock
    ? {
      ...lock,
        platform: "XIAOHONGSHU",
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
    platform: "XIAOHONGSHU",
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
