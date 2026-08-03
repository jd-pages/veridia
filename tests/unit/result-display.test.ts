import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditResultListDisplay,
  isUnavailableNoteResult,
  unavailableNoteDetailReason,
  unavailableNoteListDisplay,
  type AuditResultDisplayInput,
} from "@/lib/result-display";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const expectedDisplay = {
  contentStatus: "笔记不存在",
  topicAudit: "无",
  imageStatus: "无",
  auditConclusion: "笔记不存在",
};

describe("页面不存在类审核结果展示", () => {
  it.each([
    ["PAGE_NOT_FOUND", { task: { failureCode: "PAGE_NOT_FOUND" } }],
    ["NOTE_DELETED", { task: { failureCode: "NOTE_DELETED" } }],
    ["PAGE_UNAVAILABLE", { errorCode: "PAGE_UNAVAILABLE" }],
    ["ERROR_PAGE", { noteType: "ERROR_PAGE" }],
    ["NOT_FOUND", { pageStatus: "NOT_FOUND" }],
    ["NOT_ACCESSIBLE", { category: "NOT_ACCESSIBLE" }],
    ["DELETED", { pageStatus: "DELETED" }],
  ])("%s 在列表四列使用统一文案", (_label, result) => {
    expect(auditResultListDisplay(result)).toEqual(expectedDisplay);
  });

  it("页面标题包含你访问的页面不见了时使用统一列表文案", () => {
    const result = {
      pageStatus: "READ_FAILED",
      note: { title: "小红书 - 你访问的页面不见了", body: null },
    };

    expect(isUnavailableNoteResult(result)).toBe(true);
    expect(auditResultListDisplay(result)).toEqual(expectedDisplay);
    expect(unavailableNoteDetailReason(result)).toBe(
      "小红书页面提示“你访问的页面不见了”，疑似笔记已删除或链接失效。",
    );
  });

  it("统一列表文案不泄露技术状态或次生审核异常", () => {
    const rendered = JSON.stringify(unavailableNoteListDisplay);
    for (const hidden of [
      "ERROR_PAGE",
      "APP_LAUNCH",
      "页面失效",
      "未提取到正文 / 待人工确认",
      "暂无结论",
      "未执行话题审核",
      "未执行图片数量审核",
      "处理失败",
      "待人工复核",
      "1 项异常",
      "1项异常",
      "缺少精准话题",
      "有效正文字符不足",
      "图片数量不足",
    ]) {
      expect(rendered).not.toContain(hidden);
    }
  });

  it("正常话题缺失和正常审核通过记录不触发展示覆盖", () => {
    const normalTopicFailure: AuditResultDisplayInput = {
      pageStatus: "NORMAL",
      noteType: "IMAGE_TEXT",
      failureReasons: JSON.stringify(["缺少精准话题 #测试"]),
      note: { title: "正常笔记", body: "正常正文" },
      task: { failureCode: null, failureMessage: null },
    };
    const normalPassed: AuditResultDisplayInput = {
      pageStatus: "NORMAL",
      noteType: "IMAGE_TEXT",
      failureReasons: "[]",
      note: { title: "正常笔记", body: "正文完整" },
      task: { failureCode: null, failureMessage: null },
    };

    expect(auditResultListDisplay(normalTopicFailure)).toBeNull();
    expect(auditResultListDisplay(normalPassed)).toBeNull();
  });

  it("无权限失败不会因通用说明被误判为笔记不存在", () => {
    expect(
      isUnavailableNoteResult({
        pageStatus: "NO_PERMISSION",
        task: {
          failureCode: "NO_PERMISSION",
          failureMessage: "当前笔记无法浏览：无权限访问，需人工确认",
        },
      }),
    ).toBe(false);
  });

  it("结果列表四列和详情视图都使用共享映射", () => {
    const resultPage = source("app/(admin)/results/page.tsx");
    const topicCell = source("components/results/TopicAuditCell.tsx");
    const imageCell = source("components/results/ImageAuditCell.tsx");
    const conclusionCell = source(
      "components/results/AuditConclusionCell.tsx",
    );
    const detailPage = source("app/(admin)/results/[id]/page.tsx");
    const detailDrawer = source("components/results/AuditDetailDrawer.tsx");

    for (const item of [resultPage, topicCell, imageCell, conclusionCell]) {
      expect(item).toContain("auditResultListDisplay");
    }
    for (const item of [detailPage, detailDrawer]) {
      expect(item).toContain("isUnavailableNoteResult");
      expect(item).toContain("unavailableNoteDetailReason");
      expect(item).toContain("笔记不存在");
    }
  });
});
