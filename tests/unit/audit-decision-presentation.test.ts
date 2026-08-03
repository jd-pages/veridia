import { describe, expect, it } from "vitest";
import {
  auditConclusionCardLabel,
  auditConclusionFailureReasons,
  minimumImageCountFromRuleSnapshot,
} from "@/lib/result-detail-presentation";

function input(overrides: Record<string, unknown> = {}) {
  return {
    autoStatus: "FAILED",
    pageStatus: "NORMAL",
    noteType: "IMAGE_TEXT",
    failureReasons: "[]",
    ruleSnapshot: JSON.stringify({ minImageCount: 2 }),
    task: { failureCode: null, failureMessage: null },
    note: { title: "正常笔记", body: "正文" },
    manualReviews: [],
    ...overrides,
  };
}

describe("审核结论卡片展示映射", () => {
  it("将话题和图片失败原因转成简洁业务文案并去重", () => {
    expect(
      auditConclusionFailureReasons(
        input({
          failureReasons: JSON.stringify([
            "缺少精确话题 #爱他美奇迹绿罐",
            "IFFO 阶段话题未命中：#新生儿奶粉、#二段奶粉推荐 中至少出现 1 个",
            "图片数量不足（1/2）",
            "图片数量不足（1/2）",
          ]),
        }),
      ),
    ).toEqual([
      "缺少精准话题：#爱他美奇迹绿罐",
      "阶段话题未命中：#新生儿奶粉 / #二段奶粉推荐",
      "图片不足：当前 1 张，要求至少 2 张",
    ]);
  });

  it("笔记不存在时只展示笔记不存在，不泄露技术状态", () => {
    const unavailable = input({
      pageStatus: "NOT_FOUND",
      failureReasons: JSON.stringify([
        "ERROR_PAGE",
        "有效正文字数不足",
        "图片数量不足（0/2）",
      ]),
      task: { failureCode: "PAGE_NOT_FOUND", failureMessage: "APP_LAUNCH" },
    });
    expect(auditConclusionCardLabel(unavailable)).toBe("笔记不存在");
    expect(auditConclusionFailureReasons(unavailable)).toEqual(["笔记不存在"]);
  });

  it("读取规则快照中的动态最低图片数量", () => {
    expect(minimumImageCountFromRuleSnapshot('{"minImageCount":4}')).toBe(4);
    expect(minimumImageCountFromRuleSnapshot("invalid")).toBeNull();
  });
});
