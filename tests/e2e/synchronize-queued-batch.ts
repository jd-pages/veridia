import type { APIRequestContext } from "@playwright/test";

// Fixture synchronization, not a retry or permission to resume terminal work.
// The queue may finish between the import response and this single CONTINUE.
export async function synchronizeQueuedBatch(request: Pick<APIRequestContext, "post" | "get">, batchId: string) {
  const response = await request.post(`/api/automation/batches/${batchId}/control`, { data: { action: "CONTINUE" } });
  if (response.ok()) return "CONTINUE_ACCEPTED" as const;
  const text = await response.text();
  if (response.status() !== 400) throw new Error(`queue sync failed: ${response.status()} ${text}`);
  const error = JSON.parse(text);
  if (error.success !== false || error.errorDetail?.code !== "REQUEST_FAILED" ||
      error.error !== "已结束批次不能直接继续审核") throw new Error(`queue sync rejected unexpected response: ${text}`);
  const snapshot = await request.get(`/api/automation/batches?batchId=${batchId}`);
  if (!snapshot.ok()) throw new Error(`queue sync terminal confirmation failed: ${snapshot.status()}`);
  const data = (await snapshot.json()).data;
  if (!Array.isArray(data) || data.length !== 1) throw new Error("queue sync terminal identity is missing or ambiguous");
  const batch = data[0];
  if (batch.id !== batchId || batch.status !== "COMPLETED" || batch.currentTaskId !== null ||
      !Array.isArray(batch.tasks) || batch.tasks.length === 0 || batch.tasks.some((task: {
        status: string; auditResults?: Array<{ id?: string }>;
      }) => !["COMPLETED", "NEEDS_REVIEW", "READ_FAILED"].includes(task.status) ||
        !Array.isArray(task.auditResults) || task.auditResults.length === 0 || task.auditResults.some(result => !result.id))) {
    throw new Error("queue sync rejected without exact completed batch and persisted results");
  }
  return "ALREADY_COMPLETED" as const;
}
