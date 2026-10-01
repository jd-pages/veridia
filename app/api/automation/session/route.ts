import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  checkXhsSessionState,
  closeXhsBrowserContext,
  closeXhsAuditPageForTesting,
  completeXiaohongshuLogin,
  getXhsSessionDiagnostics,
  getE2eBrowserTeardownRuntimeSnapshot,
  logoutXhsSession,
  restartXhsBrowser,
  startXiaohongshuLogin,
} from "@/lib/automation/browser";
import {
  checkDouyinSessionState,
  closeDouyinBrowserContext,
  closeDouyinAuditPageForTesting,
  completeDouyinLogin,
  getDouyinSessionDiagnostics,
  logoutDouyinSession,
  restartDouyinBrowser,
  startDouyinLogin,
} from "@/lib/automation/douyin-browser";
import { parseAutomationPlatform } from "@/lib/automation/platform";
import { assertIdleE2eBrowserTeardown, assertIsolatedE2eBrowserTeardown } from "@/lib/testing/e2e-browser-teardown";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const platform = parseAutomationPlatform(new URL(request.url).searchParams.get("platform")) || "XIAOHONGSHU";
  return ok(platform === "DOUYIN" ? await getDouyinSessionDiagnostics() : await getXhsSessionDiagnostics());
}, "读取内容平台浏览器状态");

export const POST = withApiErrorBoundary(async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const body = (await request.json()) as {
    platform?: string;
    teardownNonce?: unknown;
    action?:
      | "START_LOGIN"
      | "COMPLETE_LOGIN"
      | "CHECK_SESSION"
      | "RESTART_BROWSER"
      | "CLOSE_AUDIT_PAGE_FOR_TEST"
      | "CLOSE_BROWSERS_FOR_E2E_TEARDOWN"
      | "LOGOUT_SESSION"
      | "LOGOUT_XHS";
  };
  const platform = parseAutomationPlatform(body.platform) || "XIAOHONGSHU";
  try {
    if (body.action === "CLOSE_BROWSERS_FOR_E2E_TEARDOWN") {
      assertIsolatedE2eBrowserTeardown(request.url, body.teardownNonce);
      const before = getE2eBrowserTeardownRuntimeSnapshot();
      assertIdleE2eBrowserTeardown(before.globalRuntimeDiagnostics, before.sessions);
      // Existing context-close operations retain their own generation/native
      // physical fences. No login, logout, session write or raw-PID adoption.
      await closeXhsBrowserContext();
      await closeDouyinBrowserContext();
      const after = getE2eBrowserTeardownRuntimeSnapshot();
      assertIdleE2eBrowserTeardown(after.globalRuntimeDiagnostics, after.sessions);
      const managers = after.globalRuntimeDiagnostics.platformBrowserManagers;
      if ([managers.XIAOHONGSHU, managers.DOUYIN].some(manager => manager.managerAvailable !== true || manager.contextPresent !== false || manager.browserConnected !== false) ||
        after.globalRuntimeDiagnostics.activeBrowserOwnerGenerations.length !== 0) {
        throw new Error("隔离测试浏览器物理关闭或所有者释放未完成");
      }
      return ok({ closed: true });
    }
    if (platform === "DOUYIN") {
      if (body.action === "START_LOGIN") return ok(await startDouyinLogin());
      if (body.action === "COMPLETE_LOGIN") return ok(await completeDouyinLogin());
      if (body.action === "CHECK_SESSION") { await checkDouyinSessionState(); return ok(await getDouyinSessionDiagnostics()); }
      if (body.action === "RESTART_BROWSER") return ok(await restartDouyinBrowser());
      if (body.action === "CLOSE_AUDIT_PAGE_FOR_TEST") return ok(await closeDouyinAuditPageForTesting());
      if (body.action === "LOGOUT_SESSION" || body.action === "LOGOUT_XHS") return ok(await logoutDouyinSession());
      return fail("不支持的抖音登录操作");
    }
    if (body.action === "START_LOGIN") {
      return ok(await startXiaohongshuLogin());
    }
    if (body.action === "COMPLETE_LOGIN") {
      return ok(await completeXiaohongshuLogin());
    }
    if (body.action === "CHECK_SESSION") {
      await checkXhsSessionState();
      return ok(await getXhsSessionDiagnostics());
    }
    if (body.action === "RESTART_BROWSER") {
      return ok(await restartXhsBrowser());
    }
    if (body.action === "CLOSE_AUDIT_PAGE_FOR_TEST") {
      return ok(await closeXhsAuditPageForTesting());
    }
    if (body.action === "LOGOUT_SESSION" || body.action === "LOGOUT_XHS") {
      return ok(await logoutXhsSession());
    }
    return fail("不支持的登录操作");
  } catch (error) {
    console.error(`[VERIDIA API] ${platform === "DOUYIN" ? "抖音" : "小红书"}专用浏览器操作失败`, error);
    return fail(
      "审核浏览器连接异常。请点击“重新启动专用浏览器”后重试；若系统策略禁止远程调试，请联系管理员检查浏览器策略。",
      500,
      "BROWSER_OPERATION_FAILED",
    );
  }
}, "操作内容平台专用浏览器");
