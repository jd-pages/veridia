import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resultDetailLinks } from "@/lib/result-links";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("审核详情链接展示", () => {
  it("原笔记链接始终使用导入任务的原始 URL", () => {
    const links = resultDetailLinks({
      task: {
        url: "https://xhslink.com/original?source=excel&row=18",
        finalUrl: "https://www.xiaohongshu.com/explore/final-task",
      },
      note: {
        url: "https://www.xiaohongshu.com/explore/note-url",
        finalUrl: "https://www.xiaohongshu.com/explore/final-note",
      },
    });

    expect(links).toEqual({
      originalUrl: "https://xhslink.com/original?source=excel&row=18",
      finalUrl: "https://www.xiaohongshu.com/explore/final-task",
    });
  });

  it("最终链接兼容取证记录和笔记 URL 回退", () => {
    expect(
      resultDetailLinks({
        task: { url: "https://xhslink.com/original", finalUrl: null },
        note: {
          url: "https://www.xiaohongshu.com/explore/note-url",
          finalUrl: "https://www.xiaohongshu.com/explore/final-note",
        },
      }).finalUrl,
    ).toBe("https://www.xiaohongshu.com/explore/final-note");

    expect(
      resultDetailLinks({
        task: { url: "https://xhslink.com/original", finalUrl: null },
        note: {
          url: "https://www.xiaohongshu.com/explore/note-url",
          finalUrl: null,
        },
      }).finalUrl,
    ).toBe("https://www.xiaohongshu.com/explore/note-url");
  });

  it("原始和最终链接相同时仍返回两个展示字段", () => {
    const url = "https://www.xiaohongshu.com/explore/same";
    expect(
      resultDetailLinks({
        task: { url, finalUrl: url },
        note: { url, finalUrl: url },
      }),
    ).toEqual({ originalUrl: url, finalUrl: url });
  });

  it("列表、完整详情和抽屉共用链接映射，复制操作使用未截断的完整值", () => {
    const resultList = source("components/results/NoteObjectCell.tsx");
    const fullDetail = source("app/(admin)/results/[id]/page.tsx");
    const drawer = source("components/results/AuditDetailDrawer.tsx");
    const decision = source("components/results/AuditDecisionSummary.tsx");
    const linkComponent = source("components/results/ResultDetailLink.tsx");

    for (const uiSource of [resultList, decision]) {
      expect(uiSource).toContain("resultDetailLinks");
      expect(uiSource).toContain('label="最终链接"');
    }
    expect(resultList).toContain('label="原笔记链接"');
    expect(decision).toContain('openText="打开原笔记"');
    expect(decision).toContain('copyText="复制原链接"');
    expect(decision).toContain('openText="打开最终链接"');
    expect(fullDetail).toContain("AuditDecisionSummary");
    expect(drawer).toContain("AuditDecisionSummary");
    expect(resultList).toContain("links.originalUrl");
    expect(resultList).toContain("links.finalUrl");
    expect(resultList).not.toContain("row.note.url}");
    expect(linkComponent).toContain("navigator.clipboard.writeText(value)");
    expect(linkComponent).toContain("href={value}");
    expect(linkComponent).toContain("title={value}");
    expect(linkComponent).toContain('variant === "actions"');
  });
});
