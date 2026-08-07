import type { AuditTask } from "@prisma/client";
import type { AutomationPlatform } from "./platform";
import {
  extractAuditTaskAutomatically,
  type AutomaticExtractionOutcome,
} from "./extract";
import { extractDouyinAuditTaskAutomatically } from "./douyin-extract";
import {
  clearXhsAuditLockForBatch,
  ensureXhsBrowserControlReady,
  heartbeatXhsAuditLock,
  markXhsSessionIssue,
  updateXhsAuditLock,
} from "./browser";
import {
  clearDouyinAuditLockForBatch,
  ensureDouyinBrowserControlReady,
  heartbeatDouyinAuditLock,
  markDouyinSessionIssue,
  updateDouyinAuditLock,
} from "./douyin-browser";
import { getAutomationPacingSettings } from "./pacing";

export interface PlatformAutomationRuntime {
  platform: AutomationPlatform;
  sessionId: string;
  extract: (task: AuditTask) => Promise<AutomaticExtractionOutcome>;
  pacing: () => ReturnType<typeof getAutomationPacingSettings>;
  ensureBrowserReady: () => Promise<unknown>;
  updateLock: typeof updateXhsAuditLock;
  heartbeatLock: typeof heartbeatXhsAuditLock;
  clearLock: typeof clearXhsAuditLockForBatch;
  markSessionIssue: (restricted: boolean, message: string) => Promise<unknown>;
}

const runtimeRegistry: Record<
  AutomationPlatform,
  () => PlatformAutomationRuntime
> = {
  DOUYIN: () => ({
      platform: "DOUYIN",
      sessionId: "douyin",
      extract: (task: AuditTask) => extractDouyinAuditTaskAutomatically(task),
      pacing: () => getAutomationPacingSettings("DOUYIN"),
      ensureBrowserReady: () => ensureDouyinBrowserControlReady(),
      updateLock: updateDouyinAuditLock,
      heartbeatLock: heartbeatDouyinAuditLock,
      clearLock: clearDouyinAuditLockForBatch,
      markSessionIssue: (restricted: boolean, message: string) => markDouyinSessionIssue(restricted ? "SECURITY_RESTRICTED" : "LOGIN_EXPIRED", message),
    }),
  XIAOHONGSHU: () => ({
    platform: "XIAOHONGSHU",
    sessionId: "xiaohongshu",
    extract: (task: AuditTask) => extractAuditTaskAutomatically(task),
    pacing: () => getAutomationPacingSettings("XIAOHONGSHU"),
    ensureBrowserReady: () => ensureXhsBrowserControlReady(true),
    updateLock: updateXhsAuditLock,
    heartbeatLock: heartbeatXhsAuditLock,
    clearLock: clearXhsAuditLockForBatch,
    markSessionIssue: (restricted: boolean, message: string) => markXhsSessionIssue(restricted ? "SECURITY_RESTRICTED" : "LOGGED_OUT", message),
  }),
};

export function automationRuntime(platform: AutomationPlatform) {
  return runtimeRegistry[platform]();
}
