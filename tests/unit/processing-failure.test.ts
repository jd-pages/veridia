import { describe, expect, it } from "vitest";
import {
  pageStatusForProcessingFailure,
  processingFailureReason,
  processingFailureTaskStatuses,
} from "@/lib/processing-failure";
import {
  buildAuditResultWhere,
  buildLocalDateRange,
  readResultQueryFilters,
} from "@/lib/result-query";

describe("处理失败结果口径", () => {
  it("将页面异常映射为明确的页面状态和人工复核原因", () => {
    expect(pageStatusForProcessingFailure("NOTE_NOT_FOUND")).toBe(
      "NOTE_NOT_FOUND",
    );
    expect(pageStatusForProcessingFailure("LOGIN_REQUIRED")).toBe(
      "LOGIN_EXPIRED",
    );
    expect(pageStatusForProcessingFailure("SECURITY_CHECK")).toBe(
      "SECURITY_VERIFICATION",
    );
    expect(processingFailureReason("NOTE_DELETED", null)).toContain(
      "笔记已删除",
    );
    expect(
      processingFailureReason(
        "PAGE_NOT_FOUND",
        "小红书页面提示“你访问的页面不见了”，疑似笔记不存在或链接失效",
      ),
    ).toBe(
      "小红书页面提示“你访问的页面不见了”，疑似笔记不存在或链接失效",
    );
    expect(processingFailureReason("BODY_NOT_RECOGNIZED", null)).toContain(
      "人工复核",
    );
    expect(
      processingFailureReason(
        "STRUCTURE_MISMATCH",
        "页面结构已匹配，但没有提取到标题或正文",
      ),
    ).toBe("页面结构异常，未提取到标题或正文，请人工确认。");
  });

  it("处理失败筛选只按任务处理状态筛选", () => {
    expect(
      buildAuditResultWhere({ status: "PROCESS_FAILED" }),
    ).toEqual({
      AND: [
        {
          task: {
            status: { in: [...processingFailureTaskStatuses] },
          },
        },
      ],
    });
  });

  it("人工复核筛选区分待复核和无需复核", () => {
    expect(
      buildAuditResultWhere({ manualStatus: "PENDING" }),
    ).toMatchObject({
      AND: [
        {
          autoStatus: "NEEDS_REVIEW",
          manualReviews: { none: {} },
        },
      ],
    });
    expect(
      buildAuditResultWhere({ manualStatus: "NOT_REQUIRED" }),
    ).toMatchObject({
      AND: [
        {
          autoStatus: { not: "NEEDS_REVIEW" },
          manualReviews: { none: {} },
        },
      ],
    });
  });

  it("日期范围使用本地时区闭区间并支持单日", () => {
    const range = buildLocalDateRange("2026-07-10", "2026-07-10");
    expect(range.gte).toBeInstanceOf(Date);
    expect(range.lte).toBeInstanceOf(Date);
    expect((range.gte as Date).getHours()).toBe(0);
    expect((range.gte as Date).getMinutes()).toBe(0);
    expect((range.lte as Date).getHours()).toBe(23);
    expect((range.lte as Date).getMinutes()).toBe(59);
    expect((range.lte as Date).getSeconds()).toBe(59);
    expect((range.lte as Date).getMilliseconds()).toBe(999);
  });

  it("日期范围支持只传开始、只传结束和清空", () => {
    expect(buildLocalDateRange("2026-07-01")).toMatchObject({
      gte: expect.any(Date),
    });
    expect(buildLocalDateRange(undefined, "2026-07-31")).toMatchObject({
      lte: expect.any(Date),
    });
    expect(buildLocalDateRange()).toEqual({});
  });

  it("日期与产品、平台、订单号、结果和保留的高级筛选叠加", () => {
    const where = buildAuditResultWhere({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      productId: "product-1",
      platform: "XIAOHONGSHU",
      orderNumber: " ORDER-10 ",
      status: "FAILED",
      pageStatus: "NORMAL",
      bodyStatus: "PRESENT",
      topicsStatus: "NON_COMPLIANT",
      imageStatus: "NON_COMPLIANT",
      noteType: "IMAGE_TEXT",
      reason: "缺少话题",
      publicStatus: "PUBLIC",
    });
    expect(where).toMatchObject({
      AND: expect.arrayContaining([
        { autoStatus: "FAILED" },
        { pageStatus: "NORMAL" },
        { bodyStatus: "PRESENT" },
        { topicsCompliant: false },
        { imageStatus: "NON_COMPLIANT" },
        { noteType: "IMAGE_TEXT" },
        { publicStatus: "PUBLIC" },
        {
          task: {
            productId: "product-1",
            orderNumber: { contains: "ORDER-10" },
            OR: expect.arrayContaining([
              { channel: "XIAOHONGSHU" },
              { channel: null, platform: "XIAOHONGSHU" },
            ]),
          },
        },
      ]),
    });
  });

  it("成交平台与内容渠道是独立条件，并兼容旧 platform 渠道", () => {
    expect(buildAuditResultWhere({
      commercePlatform: "JD",
      channel: "XIAOHONGSHU",
    })).toMatchObject({
      AND: [{
        task: {
          commercePlatform: "JD",
          OR: expect.arrayContaining([
            { channel: "XIAOHONGSHU" },
            { channel: null, platform: "XIAOHONGSHU" },
          ]),
        },
      }],
    });
    expect(
      readResultQueryFilters(
        new URLSearchParams("commercePlatform=DOUYIN_ECOMMERCE&channel=DOUYIN"),
      ),
    ).toMatchObject({ commercePlatform: "DOUYIN_ECOMMERCE", channel: "DOUYIN" });
  });

  it("笔记不存在使用独立筛选并从普通不通过、待复核中排除", () => {
    expect(buildAuditResultWhere({ status: "NOTE_NOT_FOUND" })).toMatchObject({
      AND: [
        {
          OR: expect.arrayContaining([
            { autoStatus: "NOTE_NOT_FOUND" },
            { pageStatus: { in: ["NOTE_NOT_FOUND", "NOT_FOUND", "DELETED"] } },
          ]),
        },
      ],
    });
    expect(buildAuditResultWhere({ status: "FAILED" })).toMatchObject({
      AND: [{ autoStatus: "FAILED" }, { NOT: expect.any(Object) }],
    });
    expect(buildAuditResultWhere({ status: "NEEDS_REVIEW" })).toMatchObject({
      AND: [{ autoStatus: "NEEDS_REVIEW" }, { NOT: expect.any(Object) }],
    });
  });

  it("旧高级筛选参数不再参与查询，平台参数必须使用受支持枚举", () => {
    const filters = readResultQueryFilters(
      new URLSearchParams(
        "clickableStatus=COMPLIANT&ruleVersion=2&retentionStatus=PENDING",
      ),
    );
    expect(filters).not.toHaveProperty("clickableStatus");
    expect(filters).not.toHaveProperty("ruleVersion");
    expect(filters).not.toHaveProperty("retentionStatus");
    expect(buildAuditResultWhere(filters)).toEqual({});
    expect(() => buildAuditResultWhere({ platform: "UNKNOWN" })).toThrow(
      "平台筛选条件不正确",
    );
  });

  it("拒绝无效日期和反向范围", () => {
    expect(() =>
      buildLocalDateRange("2026-02-30", "2026-03-01"),
    ).toThrow("无效日期");
    expect(() =>
      buildLocalDateRange("2026-07-31", "2026-07-01"),
    ).toThrow("开始日期");
  });

  it("导出所选将多个结果ID合并为同一次查询", () => {
    const filters = readResultQueryFilters(
      new URLSearchParams("ids=result-1,result-2,result-1"),
    );
    expect(filters.ids).toEqual(["result-1", "result-2", "result-1"]);
    expect(buildAuditResultWhere(filters)).toEqual({
      AND: [{ id: { in: ["result-1", "result-2"] } }],
    });
  });
});
