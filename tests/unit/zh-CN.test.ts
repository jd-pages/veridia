import { describe, expect, it } from "vitest";
import {
  auditResultLabels,
  businessEvidenceLabel,
  businessFailureReasonLabel,
  businessImportTypeLabel,
  businessPageTypeLabel,
  businessSourceLabel,
  businessStatusLabel,
  businessTextLabel,
  processStatusLabels,
  sessionStatusLabels,
  settingLabel,
} from "../../lib/zh-CN";

describe("业务界面中文映射", () => {
  it("分别翻译处理状态与审核结果", () => {
    expect(processStatusLabels.COMPLETED).toBe("已完成");
    expect(processStatusLabels.FAILED).toBe("处理失败");
    expect(auditResultLabels.FAILED).toBe("审核不通过");
    expect(businessStatusLabel("FAILED", "process")).toBe("处理失败");
    expect(businessStatusLabel("FAILED", "audit")).toBe("审核不通过");
    expect(businessStatusLabel("PENDING", "audit")).toBe("暂无结论");
  });

  it("翻译来源、会话、页面类型和导入类型", () => {
    expect(businessSourceLabel("MANUAL")).toBe("手动添加");
    expect(businessSourceLabel("EXCEL")).toBe("Excel导入");
    expect(sessionStatusLabels.READY).toBe("登录可用");
    expect(businessPageTypeLabel("NOTE_DETAIL")).toBe("笔记详情页");
    expect(businessImportTypeLabel("AUDIT_TASK")).toBe("审核任务");
  });

  it("翻译异常代码和系统设置项", () => {
    expect(
      businessFailureReasonLabel("STRUCTURE_MISMATCH · NETWORK_ERROR"),
    ).toBe("页面结构不匹配 · 网络错误");
    expect(settingLabel("AI_ENABLED")).toBe("启用 AI 辅助判断");
    expect(businessTextLabel("执行审核，结果 PASSED")).toBe(
      "执行审核，结果 审核通过",
    );
    expect(
      businessEvidenceLabel(
        JSON.stringify({
          pageStatus: "NORMAL",
          noteType: "IMAGE_TEXT",
          isPublic: true,
        }),
      ),
    ).toBe("页面状态：正常；笔记类型：图文笔记；是否公开：是");
  });
});
