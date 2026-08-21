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
      "缺少必带话题：#爱他美奇迹绿罐",
      "阶段话题未命中：#新生儿奶粉 / #二段奶粉推荐，需任意命中 1 个",
      "图片数量不足：当前 1 张，要求 ≥2 张",
    ]);
  });

  it("笔记不存在时只展示笔记不存在，不泄露技术状态", () => {
    const unavailable = input({
      pageStatus: "NOTE_NOT_FOUND",
      failureReasons: JSON.stringify([
        "ERROR_PAGE",
        "有效正文字数不足",
        "图片数量不足（0/2）",
      ]),
      task: { failureCode: "NOTE_NOT_FOUND", failureMessage: "APP_LAUNCH" },
    });
    expect(auditConclusionCardLabel(unavailable)).toBe("笔记不存在");
    expect(auditConclusionFailureReasons(unavailable)).toEqual([
      "小红书页面提示“你访问的页面不见了”",
    ]);
  });

  it("展示正文字数和热门话题的具体差额", () => {
    expect(
      auditConclusionFailureReasons(
        input({
          failureReasons: JSON.stringify([
            "有效正文字数不足（28/30）",
            "任意话题命中不足 2 个",
          ]),
          ruleSnapshot: JSON.stringify({
            rules: [
              { ruleType: "ANY", topic: "#热门一", minCount: 2 },
              { ruleType: "ANY", topic: "#热门二", minCount: 2 },
              { ruleType: "ANY", topic: "#热门三", minCount: 2 },
              { ruleType: "ANY", topic: "#热门四", minCount: 2 },
            ],
          }),
          note: {
            title: "正常笔记",
            body: "正文",
            topics: [{ displayText: "#热门一" }],
          },
        }),
      ),
    ).toEqual([
      "正文字数不足：当前 28 字，要求 ≥30 字",
      "热门话题不足：需 4 选 2，当前命中 1 个，还需任意 1 个；已命中：#热门一；未命中候选：#热门二、#热门三、#热门四",
    ]);
  });

  it("合并多个必带话题缺失并严格使用历史规则快照", () => {
    expect(
      auditConclusionFailureReasons(
        input({
          failureReasons: JSON.stringify([
            "缺少精确话题 #历史必带一",
            "缺少精准话题 #历史必带二",
          ]),
          missingTopics: JSON.stringify(["#历史必带一", "#历史必带二"]),
          ruleSnapshot: JSON.stringify({
            rules: [
              { ruleType: "EXACT", topic: "#历史必带一" },
              { ruleType: "EXACT", topic: "#历史必带二" },
            ],
          }),
          note: {
            title: "正常笔记",
            body: "正文",
            topics: [{ displayText: "#当前新增规则" }],
          },
        }),
      ),
    ).toEqual(["缺少必带话题：#历史必带一 / #历史必带二"]);
  });

  it("读取规则快照中的动态最低图片数量", () => {
    expect(minimumImageCountFromRuleSnapshot('{"minImageCount":4}')).toBe(4);
    expect(minimumImageCountFromRuleSnapshot("invalid")).toBeNull();
  });
});
