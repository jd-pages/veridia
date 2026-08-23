import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import { E2E_ORIGIN } from "./e2e-origin";
import { deleteImportRecordsInTransaction } from "@/lib/import-record-deletion";

const databaseUrl =
  process.env.E2E_DATABASE_URL?.trim() ||
  `file:${path.resolve(process.cwd(), "prisma", "e2e.db").replaceAll("\\", "/")}`;

async function loginAsAdmin(page: import("@playwright/test").Page) {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(response.ok()).toBeTruthy();
}

async function baseBusinessData(prisma: PrismaClient) {
  const product = await prisma.product.findFirstOrThrow({
    where: { name: { contains: "澳洲白金版" }, status: "ACTIVE" },
  });
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: {
      name: { contains: "爱他美2026年7月" },
      contentChannel: "XIAOHONGSHU",
      OR: [
        { productId: product.id },
        { products: { some: { productId: product.id } } },
      ],
    },
  });
  return { product, campaign };
}

async function createImportGraph(
  prisma: PrismaClient,
  input: {
    suffix: string;
    taskCount: number;
    resultCount: number;
    fileName?: string;
    activityName?: string;
    status?: string;
  },
) {
  const { product, campaign } = await baseBusinessData(prisma);
  const importRecord = await prisma.importRecord.create({
    data: {
      id: `import-delete-${input.suffix}`,
      fileName: input.fileName || `import-delete-${input.suffix}.xlsx`,
      importType: "AUDIT_TASK",
      totalCount: input.taskCount,
      validCount: input.taskCount,
      invalidCount: 0,
      status: "COMPLETED",
      summary: JSON.stringify({
        activities: [
          {
            activityId: campaign.id,
            importedName: input.activityName || "删除联动验收活动",
            officialName: input.activityName || campaign.name,
          },
        ],
      }),
    },
  });
  const xhsBatch = await prisma.auditBatch.create({
    data: {
      id: `batch-xhs-${input.suffix}`,
      name: `小红书导入批次-${input.suffix}`,
      importRecordId: importRecord.id,
      productId: product.id,
      campaignId: campaign.id,
      source: "EXCEL",
      channel: "XIAOHONGSHU",
      status: input.status || "COMPLETED",
      totalCount: Math.ceil(input.taskCount / 2),
    },
  });
  const douyinBatch = await prisma.auditBatch.create({
    data: {
      id: `batch-douyin-${input.suffix}`,
      name: `抖音导入批次-${input.suffix}`,
      importRecordId: importRecord.id,
      productId: product.id,
      campaignId: campaign.id,
      source: "EXCEL",
      channel: "DOUYIN",
      status: input.status || "COMPLETED",
      totalCount: Math.floor(input.taskCount / 2),
    },
  });
  const taskIds = Array.from(
    { length: input.taskCount },
    (_, index) => `task-import-delete-${input.suffix}-${index}`,
  );
  const noteIds = Array.from(
    { length: Math.max(input.taskCount, input.resultCount) },
    (_, index) => `note-import-delete-${input.suffix}-${index}`,
  );
  await prisma.noteRecord.createMany({
    data: noteIds.map((id, index) => ({
      id,
      contentChannel: "XIAOHONGSHU",
      url: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${input.suffix}&row=${index}`,
      title: `联动删除样本 ${index}`,
      body: "联动删除验收正文",
    })),
  });
  await prisma.auditTask.createMany({
    data: taskIds.map((id, index) => ({
      id,
      batchId: index % 2 === 0 ? xhsBatch.id : douyinBatch.id,
      importRecordId: importRecord.id,
      url: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${input.suffix}&row=${index}`,
      normalizedUrl: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${input.suffix}&row=${index}`,
      productId: product.id,
      campaignId: campaign.id,
      productStage: "IFFO",
      source: "EXCEL",
      status: input.status === "RUNNING" && index === 0 ? "PROCESSING" : "COMPLETED",
      claimEpoch: input.status === "RUNNING" && index === 0 ? 1 : null,
      platform: index % 2 === 0 ? "XIAOHONGSHU" : "DOUYIN",
      channel: index % 2 === 0 ? "XIAOHONGSHU" : "DOUYIN",
      queueOrder: index,
      finishedAt: input.status === "RUNNING" && index === 0 ? null : new Date(),
    })),
  });
  if (input.status === "RUNNING" && taskIds.length) {
    await prisma.auditBatch.update({
      where: { id: xhsBatch.id },
      data: { currentTaskId: taskIds[0], runEpoch: 1 },
    });
  }
  const resultIds = Array.from(
    { length: input.resultCount },
    (_, index) => `result-import-delete-${input.suffix}-${index}`,
  );
  if (resultIds.length) {
    await prisma.auditResult.createMany({
      data: resultIds.map((id, index) => ({
        id,
        auditTaskId: taskIds[index === 1 ? 0 : Math.min(index, taskIds.length - 1)],
        originTaskId: taskIds[index === 1 ? 0 : Math.min(index, taskIds.length - 1)],
        resultSlotOrder: index,
        supersededAt: index === 0 && resultIds.length > 1 ? new Date() : null,
        supersededByResultId: index === 0 && resultIds.length > 1 ? resultIds[1] : null,
        noteId: noteIds[index],
        ruleVersion: 1,
        ruleSnapshot: "{}",
        pageStatus: "NORMAL",
        bodyStatus: "PASSED",
        imageCount: 3,
        imageCompliant: true,
        topicsCompliant: true,
        clickableCompliant: true,
        autoStatus: "PASSED",
      })),
    });
    await prisma.ruleResult.create({
      data: {
        auditResultId: resultIds[0],
        ruleKey: "IMPORT_DELETE_E2E",
        ruleName: "导入删除联动",
        expectedValue: "保留事务一致性",
        actualValue: "待删除",
        passed: true,
        evidence: "e2e",
      },
    });
    const admin = await prisma.user.findUniqueOrThrow({
      where: { username: "admin" },
    });
    await prisma.manualReview.create({
      data: {
        auditResultId: resultIds[0],
        reviewerId: admin.id,
        result: "PASSED",
        comment: "联动删除验收",
      },
    });
  }
  if (taskIds.length) {
    await prisma.extractionRecord.createMany({
      data: taskIds.map((taskId, index) => ({
        auditTaskId: taskId,
        noteId: noteIds[index],
        adapterName: "import-delete-e2e",
        adapterVersion: "1",
        pageStatus: "NORMAL",
        rawData: "{}",
      })),
    });
  }
  return {
    importRecord,
    product,
    campaign,
    batchIds: [xhsBatch.id, douyinBatch.id],
    taskIds,
    noteIds,
    resultIds,
  };
}

test("导入记录表格在桌面窄窗口保持列宽、横向滚动和固定操作列", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const suffix = `${Date.now()}-layout`;
  const fileName = `这是一份用于验证导入记录表格文件名省略与横向滚动布局的超长文件-${suffix}.xlsx`;
  const activityName = "佳贝艾特超长正式活动名称用于验证活动列不会逐字换行";
  const graph = await createImportGraph(prisma, {
    suffix,
    taskCount: 1,
    resultCount: 1,
    fileName,
    activityName,
  });

  try {
    await page.goto("/imports");
    for (const width of [1920, 1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const row = page.getByRole("row").filter({ hasText: fileName });
      await expect(row).toBeVisible();

      const layout = await page.locator(".ant-table-content").evaluate((scroller, recordId) => {
        const table = scroller.querySelector("table");
        const headers = [...table!.querySelectorAll<HTMLElement>("thead th")];
        const recordRow = table!.querySelector<HTMLElement>(
          `tbody tr[data-row-key="${recordId}"]`,
        );
        const cells = [...recordRow!.querySelectorAll<HTMLElement>("td")];
        const headerByText = (text: string) =>
          headers.find((header) => header.textContent?.trim() === text)!;
        const actionCell = cells[cells.length - 1];
        return {
          clientWidth: scroller.clientWidth,
          scrollWidth: scroller.scrollWidth,
          tableWidth: table!.getBoundingClientRect().width,
          headerWhiteSpace: [
            "文件名",
            "活动名称",
            "导入类型",
            "总行数",
            "有效",
            "异常",
            "跳过",
            "审核进度",
            "状态",
            "导入时间",
            "导入人",
            "操作",
          ].map((text) => getComputedStyle(headerByText(text)).whiteSpace),
          fileCell: {
            width: cells[1].getBoundingClientRect().width,
            whiteSpace: getComputedStyle(cells[1]).whiteSpace,
            textOverflow: getComputedStyle(cells[1]).textOverflow,
          },
          activityCell: {
            width: cells[2].getBoundingClientRect().width,
            whiteSpace: getComputedStyle(cells[2]).whiteSpace,
            textOverflow: getComputedStyle(cells[2]).textOverflow,
          },
          progressCell: {
            width: cells[8].getBoundingClientRect().width,
            whiteSpace: getComputedStyle(cells[8]).whiteSpace,
            text: cells[8].textContent?.trim(),
          },
          actionCell: {
            width: actionCell.getBoundingClientRect().width,
            whiteSpace: getComputedStyle(actionCell).whiteSpace,
            position: getComputedStyle(actionCell).position,
          },
        };
      }, graph.importRecord.id);

      expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
      expect(layout.tableWidth).toBeGreaterThanOrEqual(1918);
      expect(layout.headerWhiteSpace).toEqual(Array(12).fill("nowrap"));
      expect(layout.fileCell).toMatchObject({
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
      });
      expect(layout.fileCell.width).toBeCloseTo(280, 0);
      expect(layout.activityCell).toMatchObject({
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
      });
      expect(layout.activityCell.width).toBeCloseTo(260, 0);
      expect(layout.progressCell).toMatchObject({
        whiteSpace: "nowrap",
        text: "结果 1 条 / 未完成 0 条",
      });
      expect(layout.progressCell.width).toBeCloseTo(180, 0);
      expect(layout.actionCell).toMatchObject({
        whiteSpace: "nowrap",
        position: "sticky",
      });
      expect(layout.actionCell.width).toBeCloseTo(220, 0);
      await expect(row.locator('input[type="checkbox"]')).toBeVisible();
      const resultLink = row.getByRole("link", { name: "查看审核结果", exact: true });
      const deleteButton = row.getByRole("button", { name: "删除", exact: true });
      await expect(resultLink).toBeVisible();
      await expect(deleteButton).toBeVisible();
      const [resultBox, deleteBox] = await Promise.all([
        resultLink.boundingBox(),
        deleteButton.boundingBox(),
      ]);
      expect(Math.abs(resultBox!.y - deleteBox!.y)).toBeLessThan(1);

      const scroller = page.locator(".ant-table-content");
      await scroller.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await expect(row.getByRole("button", { name: "删除", exact: true })).toBeVisible();
    }

    const row = page.getByRole("row").filter({ hasText: fileName });
    await row.locator("td").nth(1).hover();
    await expect(page.getByRole("tooltip", { name: fileName })).toBeVisible();
    await row.locator("td").nth(2).hover();
    await expect(page.getByRole("tooltip", { name: activityName })).toBeVisible();
  } finally {
    const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    await prisma.$transaction((tx) =>
      deleteImportRecordsInTransaction(tx, {
        ids: [graph.importRecord.id],
        userId: admin.id,
        mode: "SINGLE",
      }),
    );
    await prisma.noteRecord.deleteMany({ where: { id: { in: graph.noteIds } } });
    await prisma.$disconnect();
  }
});

test("单条删除联动两个平台批次、13 个任务及全版本结果，并释放重复占用", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginAsAdmin(page);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const suffix = `${Date.now()}-cascade`;
  const graph = await createImportGraph(prisma, {
    suffix,
    taskCount: 13,
    resultCount: 13,
  });
  const retainedImport = await prisma.importRecord.create({
    data: {
      id: `retained-history-import-${suffix}`,
      fileName: `retained-history-${suffix}.xlsx`,
      importType: "AUDIT_TASK",
      totalCount: 1,
      validCount: 1,
      invalidCount: 0,
      status: "COMPLETED",
      summary: "{}",
    },
  });
  const retainedTask = await prisma.auditTask.create({
    data: {
      id: `retained-history-task-${suffix}`,
      importRecordId: retainedImport.id,
      url: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${suffix}&row=1`,
      normalizedUrl: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${suffix}&row=1`,
      productId: graph.product.id,
      campaignId: graph.campaign.id,
      productStage: "IFFO",
      source: "EXCEL",
      status: "COMPLETED",
      platform: "XIAOHONGSHU",
      channel: "XIAOHONGSHU",
      finishedAt: new Date(),
    },
  });
  const retainedResult = await prisma.auditResult.create({
    data: {
      id: `retained-history-result-${suffix}`,
      auditTaskId: retainedTask.id,
      originTaskId: retainedTask.id,
      noteId: graph.noteIds[1],
      ruleVersion: 1,
      ruleSnapshot: "{}",
      pageStatus: "NORMAL",
      bodyStatus: "PASSED",
      imageCount: 3,
      imageCompliant: true,
      topicsCompliant: true,
      clickableCompliant: true,
      autoStatus: "PASSED",
    },
  });
  let recreatedTaskIds: string[] = [];
  try {
    const beforeDashboard = (await (await page.request.get("/api/dashboard")).json())
      .data as { total: number };
    const duplicateBefore = await page.request.post("/api/tasks", {
      data: {
        urls: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${suffix}&row=0`,
        productId: graph.product.id,
        campaignId: graph.campaign.id,
        productStage: "IFFO",
      },
    });
    expect(duplicateBefore.ok()).toBeTruthy();
    expect((await duplicateBefore.json()).data).toMatchObject({ created: [] });

    await page.goto("/imports");
    const row = page.getByRole("row").filter({ hasText: graph.importRecord.fileName });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "删除", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认删除导入记录？" });
    await expect(dialog).toContainText("删除联动验收活动");
    await expect(dialog).toContainText("审核任务 13 条");
    await expect(dialog).toContainText("审核结果（含历史版本） 13 条");
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByText("导入记录及其业务数据已删除", { exact: true })).toBeVisible();
    await expect(row).toHaveCount(0);

    expect(
      await prisma.importRecord.findUnique({ where: { id: graph.importRecord.id } }),
    ).toBeNull();
    expect(await prisma.auditBatch.count({ where: { id: { in: graph.batchIds } } })).toBe(0);
    expect(await prisma.auditTask.count({ where: { id: { in: graph.taskIds } } })).toBe(0);
    expect(await prisma.auditResult.count({ where: { id: { in: graph.resultIds } } })).toBe(0);
    expect(await prisma.extractionRecord.count({ where: { auditTaskId: { in: graph.taskIds } } })).toBe(0);
    expect(await prisma.ruleResult.count({ where: { auditResultId: { in: graph.resultIds } } })).toBe(0);
    expect(await prisma.manualReview.count({ where: { auditResultId: { in: graph.resultIds } } })).toBe(0);
    expect(await prisma.noteRecord.count({ where: { id: { in: graph.noteIds } } })).toBe(graph.noteIds.length);
    expect(await prisma.importRecord.findUnique({ where: { id: retainedImport.id } })).not.toBeNull();
    expect(await prisma.auditTask.findUnique({ where: { id: retainedTask.id } })).not.toBeNull();
    expect(await prisma.auditResult.findUnique({ where: { id: retainedResult.id } })).not.toBeNull();
    expect((await page.request.get(`/api/results/${graph.resultIds[0]}`)).status()).toBe(404);
    const deletedTaskPage = (await (
      await page.request.get(`/api/tasks?batchIds=${graph.batchIds.join(",")}&page=1&pageSize=50`)
    ).json()).data as { total: number };
    expect(deletedTaskPage.total).toBe(0);
    const deletedResultPage = (await (
      await page.request.get(`/api/results?importRecordId=${graph.importRecord.id}`)
    ).json()).data as { total: number };
    expect(deletedResultPage.total).toBe(0);
    const importList = (await (await page.request.get("/api/imports")).json()).data as Array<{ id: string }>;
    expect(importList.some(({ id }) => id === graph.importRecord.id)).toBe(false);
    const afterDashboard = (await (await page.request.get("/api/dashboard")).json())
      .data as { total: number };
    expect(afterDashboard.total).toBe(beforeDashboard.total - 12);

    const duplicateAfter = await page.request.post("/api/tasks", {
      data: {
        urls: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${suffix}&row=0`,
        productId: graph.product.id,
        campaignId: graph.campaign.id,
        productStage: "IFFO",
      },
    });
    expect(duplicateAfter.ok()).toBeTruthy();
    const recreated = (await duplicateAfter.json()).data as {
      created: Array<{ id: string }>;
      errors: unknown[];
    };
    expect(recreated.created).toHaveLength(1);
    expect(recreated.errors).toHaveLength(0);
    recreatedTaskIds = recreated.created.map(({ id }) => id);

    const retainedDuplicate = await page.request.post("/api/tasks", {
      data: {
        urls: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${suffix}&row=1`,
        productId: graph.product.id,
        campaignId: graph.campaign.id,
        productStage: "IFFO",
      },
    });
    expect(retainedDuplicate.ok()).toBeTruthy();
    const retainedDuplicatePayload = (await retainedDuplicate.json()).data as {
      created: unknown[];
      errors: Array<{ reason: string }>;
    };
    expect(retainedDuplicatePayload.created).toHaveLength(0);
    expect(retainedDuplicatePayload.errors).toHaveLength(1);
    expect(retainedDuplicatePayload.errors[0].reason).toContain("重复");
    expect(await prisma.auditResult.count({
      where: {
        supersededAt: null,
        task: {
          url: `${E2E_ORIGIN}/mock/xhs?case=passed&import-delete=${suffix}&row=1`,
        },
      },
    })).toBe(1);

    const deletionLog = await prisma.operationLog.findFirst({
      where: {
        action: "DELETE_IMPORT_RECORD",
        entityId: graph.importRecord.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(deletionLog?.metadata).toContain('"deletedBatchCount":2');
    expect(deletionLog?.metadata).toContain('"deletedTaskCount":13');
    expect(deletionLog?.metadata).toContain('"deletedResultCount":13');
  } finally {
    await prisma.auditTask.deleteMany({ where: { id: { in: recreatedTaskIds } } });
    await prisma.auditResult.deleteMany({ where: { id: retainedResult.id } });
    await prisma.auditTask.deleteMany({ where: { id: retainedTask.id } });
    await prisma.importRecord.deleteMany({ where: { id: retainedImport.id } });
    await prisma.noteRecord.deleteMany({ where: { id: { in: graph.noteIds } } });
    await prisma.$disconnect();
  }
});

test("批量删除全有或全无：活动执行态阻断，PAUSED 且无 writer 后整体成功", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const suffix = `${Date.now()}-bulk`;
  const safe = await createImportGraph(prisma, {
    suffix: `${suffix}-safe`,
    taskCount: 0,
    resultCount: 0,
  });
  const active = await createImportGraph(prisma, {
    suffix: `${suffix}-active`,
    taskCount: 1,
    resultCount: 0,
    status: "RUNNING",
  });
  const extraImports = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      prisma.importRecord.create({
        data: {
          id: `bulk-extra-${suffix}-${index}`,
          fileName: `bulk-extra-${suffix}-${index}.xlsx`,
          importType: "AUDIT_TASK",
          totalCount: 0,
          validCount: 0,
          invalidCount: 0,
          status: "COMPLETED",
          summary: "{}",
        },
      }),
    ),
  );
  const selectedImportIds = [
    safe.importRecord.id,
    active.importRecord.id,
    ...extraImports.map(({ id }) => id),
  ];
  try {
    const blocked = await page.request.post("/api/imports/batch-delete", {
      data: { ids: selectedImportIds },
    });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).errorDetail.code).toBe("IMPORT_HAS_ACTIVE_TASK");
    expect(await prisma.importRecord.count({
      where: { id: { in: selectedImportIds } },
    })).toBe(5);

    await prisma.auditTask.updateMany({
      where: { importRecordId: active.importRecord.id },
      data: { status: "PENDING", claimEpoch: null },
    });
    await prisma.auditBatch.updateMany({
      where: { importRecordId: active.importRecord.id },
      data: { status: "PAUSED", currentTaskId: null },
    });
    await page.goto("/imports");
    for (const fileName of [
      safe.importRecord.fileName,
      active.importRecord.fileName,
      ...extraImports.map(({ fileName }) => fileName),
    ]) {
      const row = page.getByRole("row").filter({ hasText: fileName });
      await expect(row).toBeVisible();
      await row.locator('input[type="checkbox"]').check();
    }
    await page.getByRole("button", { name: "批量删除（5）", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认批量删除 5 条导入记录？" });
    await expect(dialog).toContainText("审核任务 1 条");
    await expect(dialog).toContainText("若任一所选记录仍有任务正在执行");
    await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByText("5 条导入记录及其业务数据已全部删除", { exact: true })).toBeVisible();
    expect(await prisma.importRecord.count({
      where: { id: { in: selectedImportIds } },
    })).toBe(0);
  } finally {
    await prisma.noteRecord.deleteMany({
      where: { id: { in: [...safe.noteIds, ...active.noteIds] } },
    });
    await prisma.$disconnect();
  }
});

test("事务中间模拟失败会真实回滚 Import/Batch/Task/Result", async ({ page }) => {
  await loginAsAdmin(page);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const suffix = `${Date.now()}-rollback`;
  const graph = await createImportGraph(prisma, {
    suffix,
    taskCount: 1,
    resultCount: 1,
  });
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" } });
  try {
    await expect(
      prisma.$transaction(async (tx) => {
        await deleteImportRecordsInTransaction(tx, {
          ids: [graph.importRecord.id],
          userId: admin.id,
          mode: "SINGLE",
        });
        throw new Error("SIMULATED_IMPORT_DELETE_FAILURE");
      }),
    ).rejects.toThrow("SIMULATED_IMPORT_DELETE_FAILURE");
    expect(await prisma.importRecord.count({ where: { id: graph.importRecord.id } })).toBe(1);
    expect(await prisma.auditBatch.count({ where: { id: { in: graph.batchIds } } })).toBe(2);
    expect(await prisma.auditTask.count({ where: { id: { in: graph.taskIds } } })).toBe(1);
    expect(await prisma.auditResult.count({ where: { id: { in: graph.resultIds } } })).toBe(1);
    expect(await prisma.operationLog.count({
      where: { action: "DELETE_IMPORT_RECORD", entityId: graph.importRecord.id },
    })).toBe(0);
  } finally {
    await page.request.delete(`/api/imports/${graph.importRecord.id}`);
    await prisma.noteRecord.deleteMany({ where: { id: { in: graph.noteIds } } });
    await prisma.$disconnect();
  }
});

test("稳定 ID 隔离同名导入、VIEWER 禁止删除，并验证 1000 行删除性能", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginAsAdmin(page);
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const suffix = `${Date.now()}-identity`;
  const sharedFileName = `same-name-${suffix}.xlsx`;
  const sameNameImports = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      prisma.importRecord.create({
        data: {
          id: `same-name-${suffix}-${index}`,
          fileName: sharedFileName,
          importType: "AUDIT_TASK",
          totalCount: 0,
          validCount: 0,
          invalidCount: 0,
          status: "COMPLETED",
          summary: "{}",
        },
      }),
    ),
  );
  const { product, campaign } = await baseBusinessData(prisma);
  const performanceImport = await prisma.importRecord.create({
    data: {
      id: `performance-import-${suffix}`,
      fileName: `performance-1000-${suffix}.xlsx`,
      importType: "AUDIT_TASK",
      totalCount: 1000,
      validCount: 1000,
      invalidCount: 0,
      status: "COMPLETED",
      summary: "{}",
    },
  });
  const performanceBatch = await prisma.auditBatch.create({
    data: {
      id: `performance-batch-${suffix}`,
      importRecordId: performanceImport.id,
      source: "EXCEL",
      channel: "XIAOHONGSHU",
      status: "COMPLETED",
      totalCount: 1000,
    },
  });
  await prisma.auditTask.createMany({
    data: Array.from({ length: 1000 }, (_, index) => ({
      id: `performance-task-${suffix}-${index}`,
      importRecordId: performanceImport.id,
      batchId: performanceBatch.id,
      url: `${E2E_ORIGIN}/mock/xhs?case=passed&performance=${suffix}&row=${index}`,
      normalizedUrl: `${E2E_ORIGIN}/mock/xhs?case=passed&performance=${suffix}&row=${index}`,
      productId: product.id,
      campaignId: campaign.id,
      source: "EXCEL",
      status: "COMPLETED",
    })),
  });
  const performanceNoteIds = Array.from(
    { length: 1000 },
    (_, index) => `performance-note-${suffix}-${index}`,
  );
  await prisma.noteRecord.createMany({
    data: performanceNoteIds.map((id, index) => ({
      id,
      contentChannel: "XIAOHONGSHU",
      url: `${E2E_ORIGIN}/mock/xhs?case=passed&performance-note=${suffix}&row=${index}`,
      title: `1000 行删除 ${index}`,
    })),
  });
  await prisma.auditResult.createMany({
    data: performanceNoteIds.map((noteId, index) => ({
      id: `performance-result-${suffix}-${index}`,
      auditTaskId: `performance-task-${suffix}-${index}`,
      originTaskId: `performance-task-${suffix}-${index}`,
      noteId,
      ruleVersion: 1,
      ruleSnapshot: "{}",
      pageStatus: "NORMAL",
      bodyStatus: "PASSED",
      imageCount: 3,
      imageCompliant: true,
      topicsCompliant: true,
      clickableCompliant: true,
      autoStatus: "PASSED",
    })),
  });
  const admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" } });
  const viewer = await prisma.user.create({
    data: {
      username: `viewer_import_delete_${suffix}`,
      normalizedUsername: `viewer_import_delete_${suffix}`,
      accountId: `viewer-import-delete-${suffix}`,
      displayName: "导入删除只读验收",
      passwordHash: admin.passwordHash,
      role: "VIEWER",
      status: "ACTIVE",
      issuedAt: new Date(),
      activatedAt: new Date(),
      activationIssuer: "E2E",
      activationSchemaVersion: 1,
      authProvider: "LOCAL_ACTIVATION",
    },
  });
  try {
    const deleteSecond = await page.request.delete(
      `/api/imports/${sameNameImports[1].id}`,
    );
    expect(deleteSecond.ok()).toBeTruthy();
    expect(await prisma.importRecord.count({
      where: { id: { in: sameNameImports.map(({ id }) => id) } },
    })).toBe(3);
    expect(await prisma.importRecord.count({
      where: { id: sameNameImports[1].id },
    })).toBe(0);

    await page.request.post("/api/auth/logout");
    const viewerLogin = await page.request.post("/api/auth/login", {
      data: { username: viewer.username, password: "Admin123!" },
    });
    expect(viewerLogin.ok()).toBeTruthy();
    const forbidden = await page.request.delete(
      `/api/imports/${sameNameImports[0].id}`,
    );
    expect(forbidden.status()).toBe(403);
    expect((await forbidden.json()).errorDetail.code).toBe("PERMISSION_DENIED");
    expect(await prisma.importRecord.count({ where: { id: sameNameImports[0].id } })).toBe(1);

    await loginAsAdmin(page);
    const startedAt = performance.now();
    const performanceDelete = await page.request.delete(
      `/api/imports/${performanceImport.id}`,
    );
    const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
    expect(performanceDelete.ok()).toBeTruthy();
    expect((await performanceDelete.json()).data).toMatchObject({
      deletedImportCount: 1,
      deletedTaskCount: 1000,
      deletedResultCount: 1000,
    });
    expect(elapsedMs).toBeLessThan(30_000);
    console.info(`[IMPORT_DELETE_PERF] rows=1000 requestMs=${elapsedMs}`);
  } finally {
    await prisma.importRecord.deleteMany({
      where: { id: { in: sameNameImports.map(({ id }) => id) } },
    });
    await prisma.localAuthSession.deleteMany({ where: { userId: viewer.id } });
    await prisma.user.delete({ where: { id: viewer.id } }).catch(() => null);
    await prisma.noteRecord.deleteMany({ where: { id: { in: performanceNoteIds } } });
    await prisma.$disconnect();
  }
});
