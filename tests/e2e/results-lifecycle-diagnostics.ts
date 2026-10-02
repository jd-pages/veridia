import { type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

// Failure-only, isolated E2E observations. Never serialize business text,
// extraction content, environment or credentials into this receipt.
export async function captureResultsLifecycleFailure(page: Page, info: TestInfo) {
  const database = process.env.E2E_DATABASE_URL;
  const runsRoot = path.resolve(".playwright/e2e-runs");
  if (process.env.VERIDIA_E2E !== "true" || !database?.startsWith("file:") ||
      path.dirname(path.dirname(database.slice(5))) !== runsRoot) throw new Error("RESULTS_DIAGNOSTIC_ISOLATION_REQUIRED");
  const read = async (url: string) => {
    try {
      const response = await page.request.get(url, { timeout: 3_000, maxRetries: 0 });
      if (!response.ok()) return { unavailable: true, httpStatus: response.status() };
      return (await response.json()).data;
    } catch { return { unavailable: true }; }
  };
  const [batches, tasks, results, xhs, douyin] = await Promise.all([
    read("/api/automation/batches"), read("/api/tasks"), read("/api/results?page=1&pageSize=100"),
    read("/api/automation/session?platform=XIAOHONGSHU"), read("/api/automation/session?platform=DOUYIN"),
  ]);
  const pick = (item: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key, item[key] ?? null]));
  const batchRows = Array.isArray(batches) ? batches.filter(item => item.status === "PAUSED" || item.status === "RUNNING") : [];
  const taskRows = Array.isArray(tasks) ? tasks.filter(item => ["PENDING", "PROCESSING"].includes(item.status)) : [];
  const receipt = {
    batchRows: batchRows.slice(0, 50).map(item => pick(item, ["id", "status", "channel", "runEpoch", "currentTaskId", "lastErrorCode"])),
    taskRows: taskRows.slice(0, 100).map(item => pick(item, ["id", "batchId", "status", "failureCode", "platform", "attempts", "claimEpoch"])),
    results: Array.isArray(results?.items) ? results.items.map((item: Record<string, unknown>) => pick(item, ["id", "version", "taskId"])) : [],
    platforms: Object.fromEntries([["XIAOHONGSHU", xhs], ["DOUYIN", douyin]].map(([platform, session]) => [platform,
      pick(session ?? {}, ["physicalCloseState", "physicalCloseFailure", "controlState", "controlReady", "activeBrowserOwnerGeneration", "browserInstanceCount", "lifecycleGeneration"])])),
  };
  await info.attach("results-lifecycle-failure", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });
}
