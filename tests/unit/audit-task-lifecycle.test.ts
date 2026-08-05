import { describe, expect, it } from "vitest";
import {
  completedAuditBatchUpdate,
  completedAuditTaskUpdate,
} from "../../lib/automation/task-lifecycle";

describe("审核任务和批次完成时间", () => {
  it("任务进入 COMPLETED 时同步写入 finishedAt", () => {
    const finishedAt = new Date("2026-08-05T10:09:35.000Z");

    expect(completedAuditTaskUpdate(finishedAt)).toEqual({
      status: "COMPLETED",
      finishedAt,
    });
  });

  it("批次完成时同步写入 finishedAt 并清除当前任务", () => {
    const finishedAt = new Date("2026-08-05T10:09:35.000Z");

    expect(completedAuditBatchUpdate(false, finishedAt)).toEqual({
      status: "COMPLETED",
      currentTaskId: null,
      finishedAt,
    });
    expect(completedAuditBatchUpdate(true, finishedAt).status).toBe(
      "COMPLETED_WITH_ERRORS",
    );
  });
});
