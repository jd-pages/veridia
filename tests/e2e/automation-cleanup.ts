import { expect, type Page } from "@playwright/test";

const TERMINAL_BATCH_STATUSES = new Set([
  "CANCELLED",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "LOGIN_EXPIRED",
  "PAUSED",
  "READ_FAILED",
  "SECURITY_RESTRICTED",
]);

async function readBatchStatus(page: Page, batchId: string) {
  const response = await page.request.get(
    `/api/automation/batches?batchId=${batchId}&includeTasks=false`,
  );
  const batch = (
    (await response.json()).data as Array<{ status: string }>
  )[0];
  return batch?.status || "CLEARED";
}

export async function cleanupAutomaticBatches(
  page: Page,
  batchIds: string[],
) {
  for (const batchId of [...new Set(batchIds)].reverse()) {
    const status = await readBatchStatus(page, batchId);
    if (status === "CLEARED") continue;
    if (!TERMINAL_BATCH_STATUSES.has(status)) {
      const cancel = await page.request.post(
        `/api/automation/batches/${batchId}/control`,
        { data: { action: "CANCEL" } },
      );
      expect(cancel.ok()).toBeTruthy();
      await expect
        .poll(() => readBatchStatus(page, batchId), { timeout: 15_000 })
        .toMatch(/^(?:CANCELLED|CLEARED)$/u);
    }
    const clear = await page.request.post(
      `/api/automation/batches/${batchId}/clear`,
    );
    expect(clear.ok()).toBeTruthy();
  }
}
