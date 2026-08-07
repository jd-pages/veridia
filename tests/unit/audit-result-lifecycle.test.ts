import { describe, expect, it, vi } from "vitest";
import {
  currentAuditResultWhere,
  markAuditResultSuperseded,
  resolveAuditResultSlot,
} from "@/lib/audit-result-lifecycle";

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    auditResult: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    importRecord: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    auditBatch: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  };
}

const task = {
  id: "task-current",
  batchId: "batch-1",
  importRecordId: "import-1",
  queueOrder: 7,
  replacesResultId: null,
  createdAt: new Date("2026-08-07T01:02:03.000Z"),
};

describe("审核结果当前版本与稳定槽位", () => {
  it("默认查询只返回未被替换的当前结果", () => {
    expect(currentAuditResultWhere).toEqual({ supersededAt: null });
  });

  it("首次审核以导入时间和原始行序建立结果槽位", async () => {
    const importedAt = new Date("2026-08-06T08:00:00.000Z");
    const tx = transaction();
    tx.importRecord.findUnique.mockResolvedValue({ createdAt: importedAt });
    const slot = await resolveAuditResultSlot(
      tx as never,
      task,
    );
    expect(slot).toEqual({
      originTaskId: "task-current",
      resultSlotOrder: 7,
      resultSlotCreatedAt: importedAt,
      replacementResultId: null,
    });
  });

  it("重新审核继承原槽位而不采用新批次顺序", async () => {
    const slotAt = new Date("2026-08-06T08:00:00.000Z");
    const tx = transaction();
    tx.auditResult.findUnique.mockResolvedValue({
      id: "result-old",
      auditTaskId: "task-origin",
      originTaskId: "task-origin",
      resultSlotOrder: 42,
      resultSlotCreatedAt: slotAt,
      createdAt: slotAt,
      supersededAt: null,
    });
    const slot = await resolveAuditResultSlot(tx as never, {
      ...task,
      id: "task-reaudit",
      queueOrder: 0,
      replacesResultId: "result-old",
      createdAt: new Date("2026-08-07T08:00:00.000Z"),
    });
    expect(slot).toEqual({
      originTaskId: "task-origin",
      resultSlotOrder: 42,
      resultSlotCreatedAt: slotAt,
      replacementResultId: "result-old",
    });
  });

  it("只允许原子替换仍为当前版本的旧结果", async () => {
    const tx = transaction();
    const supersededAt = new Date("2026-08-07T09:00:00.000Z");
    await markAuditResultSuperseded(tx as never, {
      previousResultId: "result-old",
      nextResultId: "result-new",
      supersededAt,
    });
    expect(tx.auditResult.updateMany).toHaveBeenCalledWith({
      where: { id: "result-old", supersededAt: null },
      data: {
        supersededAt,
        supersededByResultId: "result-new",
      },
    });

    tx.auditResult.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      markAuditResultSuperseded(tx as never, {
        previousResultId: "result-old",
        nextResultId: "result-racing",
        supersededAt,
      }),
    ).rejects.toThrow("结果版本发生冲突");
  });

  it("已失效历史结果不能再次作为重新审核目标", async () => {
    const tx = transaction();
    tx.auditResult.findUnique.mockResolvedValue({
      id: "result-old",
      auditTaskId: "task-origin",
      originTaskId: "task-origin",
      resultSlotOrder: 1,
      resultSlotCreatedAt: task.createdAt,
      createdAt: task.createdAt,
      supersededAt: new Date(),
    });
    await expect(
      resolveAuditResultSlot(tx as never, {
        ...task,
        replacesResultId: "result-old",
      }),
    ).rejects.toThrow("结果已被更新");
  });
});
