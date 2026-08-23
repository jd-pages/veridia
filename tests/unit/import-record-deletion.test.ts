import type { Prisma } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deleteImportRecordsInTransaction,
  ImportRecordDeletionError,
  normalizeImportRecordIds,
} from "@/lib/import-record-deletion";

function transactionFixture(input?: {
  ids?: string[];
  activeBatch?: boolean;
  taskCount?: number;
  resultCount?: number;
  batchCount?: number;
}) {
  const ids = input?.ids || ["import-1"];
  const records = ids.map((id, index) => ({
    id,
    fileName: `file-${index + 1}.xlsx`,
    importType: "AUDIT_TASK",
    totalCount: 13,
    createdAt: new Date("2026-08-23T08:00:00.000Z"),
    summary: JSON.stringify({
      activities: [{ activityId: "campaign-1", officialName: "正式活动" }],
    }),
  }));
  const taskCount = input?.taskCount ?? 13;
  const resultCount = input?.resultCount ?? 13;
  const calls = {
    findImports: vi.fn().mockResolvedValue(records),
    findBatches: vi.fn().mockResolvedValue(
      [{ id: "batch-xhs" }, { id: "batch-douyin" }].slice(
        0,
        input?.batchCount ?? 2,
      ),
    ),
    findActiveBatch: vi.fn().mockResolvedValue(
      input?.activeBatch
        ? {
            id: "batch-xhs",
            name: "运行中批次",
            status: "RUNNING",
            currentTaskId: "task-1",
          }
        : null,
    ),
    deleteReviews: vi.fn().mockResolvedValue({ count: 1 }),
    deleteRules: vi.fn().mockResolvedValue({ count: 2 }),
    deleteResults: vi.fn().mockResolvedValue({ count: resultCount }),
    deleteExtractions: vi.fn().mockResolvedValue({ count: taskCount }),
    deleteTasks: vi.fn().mockResolvedValue({ count: taskCount }),
    deleteBatches: vi.fn().mockResolvedValue({ count: input?.batchCount ?? 2 }),
    deleteImports: vi.fn().mockResolvedValue({ count: ids.length }),
    createLog: vi.fn().mockResolvedValue({ id: "log-1" }),
  };
  const tx = {
    importRecord: {
      findMany: calls.findImports,
      deleteMany: calls.deleteImports,
    },
    auditBatch: {
      findMany: calls.findBatches,
      findFirst: calls.findActiveBatch,
      deleteMany: calls.deleteBatches,
    },
    auditTask: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(taskCount),
      deleteMany: calls.deleteTasks,
    },
    auditResult: {
      count: vi.fn().mockResolvedValue(resultCount),
      deleteMany: calls.deleteResults,
    },
    extractionRecord: {
      count: vi.fn().mockResolvedValue(taskCount),
      deleteMany: calls.deleteExtractions,
    },
    ruleResult: {
      count: vi.fn().mockResolvedValue(2),
      deleteMany: calls.deleteRules,
    },
    manualReview: {
      count: vi.fn().mockResolvedValue(1),
      deleteMany: calls.deleteReviews,
    },
    operationLog: { create: calls.createLog },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

describe("导入记录联动删除事务", () => {
  it("去重并严格校验稳定 ImportRecord ID", () => {
    expect(normalizeImportRecordIds([" import-1 ", "import-1", "import-2"]))
      .toEqual(["import-1", "import-2"]);
    expect(() => normalizeImportRecordIds([])).toThrow(
      ImportRecordDeletionError,
    );
    expect(() => normalizeImportRecordIds(["import-1", ""])).toThrow(
      "导入记录 ID 格式不正确",
    );
    expect(() =>
      normalizeImportRecordIds(
        Array.from({ length: 201 }, (_, index) => `import-${index}`),
      ),
    ).toThrow("单次最多删除 200 条导入记录");
  });

  it("按直属关系删除两个渠道批次、任务、全版本结果和临时提取数据，但保留共享主数据", async () => {
    const { tx, calls } = transactionFixture();
    const result = await deleteImportRecordsInTransaction(tx, {
      ids: ["import-1"],
      userId: "admin-1",
      mode: "SINGLE",
    });

    expect(result).toMatchObject({
      deletedImportCount: 1,
      deletedBatchCount: 2,
      deletedTaskCount: 13,
      deletedResultCount: 13,
      deletedExtractionCount: 13,
      deletedBatchIds: ["batch-xhs", "batch-douyin"],
      sharedNoteRecordsRetained: true,
    });
    expect(calls.deleteReviews).toHaveBeenCalledBefore(calls.deleteResults);
    expect(calls.deleteRules).toHaveBeenCalledBefore(calls.deleteResults);
    expect(calls.deleteResults).toHaveBeenCalledBefore(calls.deleteTasks);
    expect(calls.deleteExtractions).toHaveBeenCalledBefore(calls.deleteTasks);
    expect(calls.deleteTasks).toHaveBeenCalledBefore(calls.deleteBatches);
    expect(calls.deleteBatches).toHaveBeenCalledBefore(calls.deleteImports);
    expect(calls.createLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "DELETE_IMPORT_RECORD",
        entityType: "IMPORT_RECORD",
        entityId: "import-1",
        metadata: expect.stringContaining('"deletedResultCount":13'),
      }),
    });

    const source = fs.readFileSync(
      path.resolve(process.cwd(), "lib/import-record-deletion.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /tx\.(noteRecord|product|campaign|topicRule|storeTopicRule)\.delete/u,
    );
  });

  it("一个 Batch、13 Tasks、13 Results 的标准链路可完整删除", async () => {
    const { tx } = transactionFixture({
      batchCount: 1,
      taskCount: 13,
      resultCount: 13,
    });
    await expect(
      deleteImportRecordsInTransaction(tx, {
        ids: ["import-1"],
        userId: "admin-1",
        mode: "SINGLE",
      }),
    ).resolves.toMatchObject({
      deletedImportCount: 1,
      deletedBatchCount: 1,
      deletedTaskCount: 13,
      deletedResultCount: 13,
    });
  });

  it("没有下游数据的导入记录也可删除并保留审计日志", async () => {
    const { tx, calls } = transactionFixture({
      taskCount: 0,
      resultCount: 0,
    });
    calls.findBatches.mockResolvedValueOnce([]);
    calls.deleteBatches.mockResolvedValueOnce({ count: 0 });
    calls.deleteExtractions.mockResolvedValueOnce({ count: 0 });

    await expect(
      deleteImportRecordsInTransaction(tx, {
        ids: ["import-1"],
        userId: "admin-1",
        mode: "SINGLE",
      }),
    ).resolves.toMatchObject({
      deletedImportCount: 1,
      deletedBatchCount: 0,
      deletedTaskCount: 0,
      deletedResultCount: 0,
    });
    expect(calls.createLog).toHaveBeenCalledOnce();
  });

  it("批量选择中只要一个批次仍有 claim/runner 状态就整体阻断", async () => {
    const { tx, calls } = transactionFixture({
      ids: ["import-1", "import-2"],
      activeBatch: true,
    });
    await expect(
      deleteImportRecordsInTransaction(tx, {
        ids: ["import-1", "import-2"],
        userId: "admin-1",
        mode: "BULK",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_HAS_ACTIVE_TASK", status: 409 });
    expect(calls.deleteResults).not.toHaveBeenCalled();
    expect(calls.deleteTasks).not.toHaveBeenCalled();
    expect(calls.deleteImports).not.toHaveBeenCalled();
    expect(calls.createLog).not.toHaveBeenCalled();
  });

  it("没有 Batch 关系的遗留 Task 若仍在 PROCESSING 也会阻断", async () => {
    const { tx, calls } = transactionFixture();
    calls.findBatches.mockResolvedValueOnce([]);
    calls.findActiveBatch.mockResolvedValueOnce(null);
    vi.mocked(tx.auditTask.findFirst).mockResolvedValueOnce({
      id: "orphan-processing-task",
      status: "PROCESSING",
      batchId: null,
    } as never);
    await expect(
      deleteImportRecordsInTransaction(tx, {
        ids: ["import-1"],
        userId: "admin-1",
        mode: "SINGLE",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_HAS_ACTIVE_TASK", status: 409 });
    expect(calls.deleteImports).not.toHaveBeenCalled();
  });

  it("缺失一个 ID 时批量事务不删除任何记录", async () => {
    const { tx, calls } = transactionFixture({ ids: ["import-1"] });
    await expect(
      deleteImportRecordsInTransaction(tx, {
        ids: ["import-1", "missing-import"],
        userId: "admin-1",
        mode: "BULK",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_RECORD_NOT_FOUND", status: 404 });
    expect(calls.deleteImports).not.toHaveBeenCalled();
    expect(calls.createLog).not.toHaveBeenCalled();
  });

  it("删除末尾的审计日志写入失败会向 Prisma 事务抛错以触发整体回滚", async () => {
    const { tx, calls } = transactionFixture();
    calls.createLog.mockRejectedValueOnce(new Error("simulated write failure"));
    await expect(
      deleteImportRecordsInTransaction(tx, {
        ids: ["import-1"],
        userId: "admin-1",
        mode: "SINGLE",
      }),
    ).rejects.toThrow("simulated write failure");
    expect(calls.deleteImports).toHaveBeenCalledOnce();
    expect(calls.createLog).toHaveBeenCalledOnce();
  });
});
