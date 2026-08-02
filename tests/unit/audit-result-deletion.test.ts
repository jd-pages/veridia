import type { Prisma } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AuditResultDeletionValidationError,
  deleteAuditResultsInTransaction,
  normalizeAuditResultIds,
} from "@/lib/audit-result-deletion";

function transactionFixture(existingIds: string[]) {
  const calls = {
    findMany: vi.fn().mockResolvedValue(
      existingIds.map((id) => ({
        id,
        auditTaskId: `task-${id}`,
        noteId: `note-${id}`,
      })),
    ),
    deleteManualReviews: vi.fn().mockResolvedValue({ count: 2 }),
    deleteRuleResults: vi.fn().mockResolvedValue({ count: 4 }),
    deleteResults: vi.fn().mockResolvedValue({ count: existingIds.length }),
    findFailureTasks: vi.fn().mockResolvedValue(
      existingIds.map((id) => ({ id: `task-${id}` })),
    ),
    closeFailureTasks: vi.fn().mockResolvedValue({ count: existingIds.length }),
    createLog: vi.fn().mockResolvedValue({ id: "log-1" }),
  };
  const tx = {
    auditResult: {
      findMany: calls.findMany,
      deleteMany: calls.deleteResults,
    },
    manualReview: { deleteMany: calls.deleteManualReviews },
    ruleResult: { deleteMany: calls.deleteRuleResults },
    auditTask: {
      findMany: calls.findFailureTasks,
      updateMany: calls.closeFailureTasks,
    },
    operationLog: { create: calls.createLog },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls };
}

describe("审核结果删除事务", () => {
  it("以 Prisma 事务包裹明细、主记录和日志写入", () => {
    const deletionSource = fs.readFileSync(
      path.resolve(process.cwd(), "lib/audit-result-deletion.ts"),
      "utf8",
    );
    expect(deletionSource).toContain("prisma.$transaction");
    expect(deletionSource).not.toMatch(/tx\.(auditTask|noteRecord|product|campaign|topicRule)\.delete/u);
  });

  it("去重并校验批量 ID", () => {
    expect(normalizeAuditResultIds([" result-1 ", "result-1", "result-2"]))
      .toEqual(["result-1", "result-2"]);
    expect(() => normalizeAuditResultIds([])).toThrow(
      AuditResultDeletionValidationError,
    );
    expect(() => normalizeAuditResultIds(["result-1", ""])).toThrow(
      "审核结果 ID 格式不正确",
    );
    expect(() =>
      normalizeAuditResultIds(
        Array.from({ length: 201 }, (_, index) => `result-${index}`),
      ),
    ).toThrow("单次最多删除 200 条审核结果");
  });

  it("只删除审核结果及其直属明细并写入审计日志", async () => {
    const { tx, calls } = transactionFixture(["result-1", "result-2"]);

    await expect(
      deleteAuditResultsInTransaction(tx, {
        ids: ["result-1", "result-2"],
        userId: "admin-1",
        mode: "BULK",
      }),
    ).resolves.toEqual({
      deletedCount: 2,
      deletedIds: ["result-1", "result-2"],
    });

    expect(calls.deleteManualReviews).toHaveBeenCalledWith({
      where: { auditResultId: { in: ["result-1", "result-2"] } },
    });
    expect(calls.deleteRuleResults).toHaveBeenCalledWith({
      where: { auditResultId: { in: ["result-1", "result-2"] } },
    });
    expect(calls.deleteResults).toHaveBeenCalledWith({
      where: { id: { in: ["result-1", "result-2"] } },
    });
    expect(calls.findFailureTasks).toHaveBeenCalledWith({
      where: {
        id: { in: ["task-result-1", "task-result-2"] },
        status: { in: ["FAILED", "READ_FAILED", "LOGIN_EXPIRED"] },
        auditResults: { none: {} },
      },
      select: { id: true },
    });
    expect(calls.closeFailureTasks).toHaveBeenCalledWith({
      where: { id: { in: ["task-result-1", "task-result-2"] } },
      data: {
        status: "CANCELLED",
        failureCode: "CANCELLED",
        failureMessage: "对应审核结果已删除，可重新提交审核",
      },
    });
    expect(calls.createLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "admin-1",
        action: "BULK_DELETE_AUDIT_RESULTS",
        entityType: "AUDIT_RESULT",
        metadata: expect.stringContaining("task-result-1"),
      }),
    });
    expect(calls.deleteManualReviews.mock.invocationCallOrder[0]).toBeLessThan(
      calls.deleteResults.mock.invocationCallOrder[0],
    );
    expect(calls.deleteRuleResults.mock.invocationCallOrder[0]).toBeLessThan(
      calls.deleteResults.mock.invocationCallOrder[0],
    );
  });

  it("不存在的 ID 安全返回零且不触发任何删除", async () => {
    const { tx, calls } = transactionFixture([]);
    await expect(
      deleteAuditResultsInTransaction(tx, {
        ids: ["missing-result"],
        userId: "admin-1",
        mode: "SINGLE",
      }),
    ).resolves.toEqual({ deletedCount: 0, deletedIds: [] });
    expect(calls.deleteManualReviews).not.toHaveBeenCalled();
    expect(calls.deleteRuleResults).not.toHaveBeenCalled();
    expect(calls.deleteResults).not.toHaveBeenCalled();
    expect(calls.findFailureTasks).not.toHaveBeenCalled();
    expect(calls.closeFailureTasks).not.toHaveBeenCalled();
    expect(calls.createLog).toHaveBeenCalledOnce();
  });

  it("主记录删除后的日志写入失败仍会抛给 Prisma 事务以整体回滚", async () => {
    const { tx, calls } = transactionFixture(["result-1"]);
    calls.createLog.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      deleteAuditResultsInTransaction(tx, {
        ids: ["result-1"],
        userId: "admin-1",
        mode: "SINGLE",
      }),
    ).rejects.toThrow("write failed");
    expect(calls.deleteResults).toHaveBeenCalledOnce();
    expect(calls.createLog).toHaveBeenCalledOnce();
  });
});
