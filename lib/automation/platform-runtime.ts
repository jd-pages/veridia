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
  getXhsAutomationProfilePath,
  heartbeatXhsAuditLock,
  markXhsSessionIssue,
  updateXhsAuditLock,
} from "./browser";
import {
  clearDouyinAuditLockForBatch,
  ensureDouyinBrowserControlReady,
  getDouyinAutomationProfilePath,
  heartbeatDouyinAuditLock,
  markDouyinSessionIssue,
  updateDouyinAuditLock,
} from "./douyin-browser";
import { getAutomationPacingSettings } from "./pacing";

export interface PlatformAutomationRuntime {
  platform: AutomationPlatform;
  sessionId: string;
  browserSessionType: "XHS_PERSISTENT_CONTEXT" | "DOUYIN_PERSISTENT_CONTEXT";
  browserPlatform: AutomationPlatform;
  adapterName: "playwright-xiaohongshu" | "playwright-douyin";
  adapterPlatform: AutomationPlatform;
  classifierName: "classifyAutomaticPage" | "classifyDouyinPage";
  classifierPlatform: AutomationPlatform;
  profilePath: () => string;
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
      browserSessionType: "DOUYIN_PERSISTENT_CONTEXT",
      browserPlatform: "DOUYIN",
      adapterName: "playwright-douyin",
      adapterPlatform: "DOUYIN",
      classifierName: "classifyDouyinPage",
      classifierPlatform: "DOUYIN",
      profilePath: () => getDouyinAutomationProfilePath(),
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
    browserSessionType: "XHS_PERSISTENT_CONTEXT",
    browserPlatform: "XIAOHONGSHU",
    adapterName: "playwright-xiaohongshu",
    adapterPlatform: "XIAOHONGSHU",
    classifierName: "classifyAutomaticPage",
    classifierPlatform: "XIAOHONGSHU",
    profilePath: () => getXhsAutomationProfilePath(),
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
