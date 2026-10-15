import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { synchronizeQueuedBatch } from "../e2e/synchronize-queued-batch";

const terminalError = { success: false, error: "已结束批次不能直接继续审核", errorDetail: { code: "REQUEST_FAILED" } };
const completed = { id: "owned-batch", status: "COMPLETED", currentTaskId: null,
  tasks: [{ status: "NEEDS_REVIEW", auditResults: [{ id: "persisted-result" }] }] };
function fixture(status = 400, error: unknown = terminalError, data: unknown = [completed]) {
  const post = vi.fn(async () => ({ ok: () => status === 200, status: () => status, text: async () => JSON.stringify(error) }) as APIResponse);
  const get = vi.fn(async () => ({ ok: () => true, json: async () => ({ data }) }) as APIResponse);
  return { post, get } as unknown as Pick<APIRequestContext, "post" | "get"> & { post: typeof post; get: typeof get };
}
it("a single accepted CONTINUE needs no extra terminal query", async () => {
  const request = fixture(200);
  await expect(synchronizeQueuedBatch(request, "owned-batch")).resolves.toBe("CONTINUE_ACCEPTED");
  expect(request.post).toHaveBeenCalledTimes(1); expect(request.get).not.toHaveBeenCalled();
});
it("a terminal 400 is accepted only after exact completed identity and persisted results are proven", async () => {
  const request = fixture();
  await expect(synchronizeQueuedBatch(request, "owned-batch")).resolves.toBe("ALREADY_COMPLETED");
  expect(request.post).toHaveBeenCalledTimes(1); expect(request.get).toHaveBeenCalledExactlyOnceWith("/api/automation/batches?batchId=owned-batch");
});
it.each(["QUEUED", "RUNNING", "PAUSED", "CANCELLED", "FAILED"])("terminal rejection with %s state still fails without retry", async status => {
  const request = fixture(400, terminalError, [{ ...completed, status }]);
  await expect(synchronizeQueuedBatch(request, "owned-batch")).rejects.toThrow("exact completed batch");
  expect(request.post).toHaveBeenCalledTimes(1);
});
it.each([
  [], [completed, completed], [{ ...completed, id: "other-batch" }], [{ ...completed, currentTaskId: "active-task" }],
  [{ ...completed, tasks: [] }], [{ ...completed, tasks: [{ status: "NEEDS_REVIEW", auditResults: [] }] }],
].map(data => ({ data })))("missing, ambiguous, active or resultless identity remains rejected: %j", async ({ data }) => {
  const request = fixture(400, terminalError, data);
  await expect(synchronizeQueuedBatch(request, "owned-batch")).rejects.toThrow(); expect(request.post).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 500])("unrelated HTTP %s remains failed without a confirmation query or retry", async status => {
  const request = fixture(status);
  await expect(synchronizeQueuedBatch(request, "owned-batch")).rejects.toThrow("queue sync failed");
  expect(request.post).toHaveBeenCalledTimes(1); expect(request.get).not.toHaveBeenCalled();
});
it("unrelated 400 and transport failures are not swallowed", async () => {
  const request = fixture(400, { ...terminalError, error: "another error" });
  await expect(synchronizeQueuedBatch(request, "owned-batch")).rejects.toThrow("unexpected response");
  expect(request.get).not.toHaveBeenCalled();
  request.post.mockRejectedValueOnce(new Error("ECONNRESET"));
  await expect(synchronizeQueuedBatch(request, "owned-batch")).rejects.toThrow("ECONNRESET");
  expect(request.post).toHaveBeenCalledTimes(2); expect(request.get).not.toHaveBeenCalled();
});
