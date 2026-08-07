import { describe, expect, it } from "vitest";
import { sortAuditResultsByImportOrder } from "@/lib/result-export-order";

describe("审核结果导出顺序", () => {
  it("同一导入批次按原始 queueOrder 正序并保持跨批次稳定", () => {
    const firstBatchAt = new Date("2026-08-04T01:00:00.000Z");
    const secondBatchAt = new Date("2026-08-04T02:00:00.000Z");
    const row = (
      id: string,
      batchId: string,
      batchCreatedAt: Date,
      queueOrder: number,
    ) => ({
      id,
      createdAt: new Date("2026-08-04T03:00:00.000Z"),
      task: {
        batchId,
        queueOrder,
        createdAt: batchCreatedAt,
        batch: { createdAt: batchCreatedAt },
      },
    });
    const rows = [
      row("second-2", "second", secondBatchAt, 1),
      row("first-2", "first", firstBatchAt, 1),
      row("second-1", "second", secondBatchAt, 0),
      row("first-1", "first", firstBatchAt, 0),
    ];

    expect(sortAuditResultsByImportOrder(rows).map((item) => item.id)).toEqual([
      "first-1",
      "first-2",
      "second-1",
      "second-2",
    ]);
  });

  it("重新审核结果使用稳定槽位而不是新批次和新任务顺序", () => {
    const importAt = new Date("2026-08-06T01:00:00.000Z");
    const row = (
      id: string,
      resultSlotOrder: number,
      taskBatchAt: Date,
      taskQueueOrder: number,
    ) => ({
      id,
      createdAt: taskBatchAt,
      resultSlotOrder,
      resultSlotCreatedAt: importAt,
      task: {
        batchId: `batch-${id}`,
        queueOrder: taskQueueOrder,
        createdAt: taskBatchAt,
        batch: { createdAt: taskBatchAt },
      },
    });
    const rows = [
      row("third", 4, new Date("2026-08-06T01:00:00.000Z"), 2),
      row("second-latest", 3, new Date("2026-08-07T10:00:00.000Z"), 0),
      row("first", 2, new Date("2026-08-06T01:00:00.000Z"), 0),
    ];

    expect(sortAuditResultsByImportOrder(rows).map((item) => item.id)).toEqual([
      "first",
      "second-latest",
      "third",
    ]);
  });
});
