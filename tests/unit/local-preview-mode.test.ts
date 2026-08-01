import { describe, expect, it } from "vitest";
import {
  isIsolatedLocalPreview,
  isLocalPreviewMode,
} from "@/lib/local-preview-mode";
import { isDatabaseSchemaMismatch } from "@/lib/database-errors";

const validPreviewEnvironment = {
  VERIDIA_LOCAL_PREVIEW: "1",
  VERIDIA_RUNTIME_KIND: "source-preview",
  VERIDIA_PREVIEW_DATA_MODE: "isolated",
  NODE_ENV: "development",
};

describe("本地预览模式保护", () => {
  it("仅在明确的源码开发环境中启用", () => {
    expect(isLocalPreviewMode(validPreviewEnvironment)).toBe(true);
    expect(isIsolatedLocalPreview(validPreviewEnvironment)).toBe(true);
  });

  it("packaged、桌面或生产环境不能绕过正式认证", () => {
    expect(
      isLocalPreviewMode({
        ...validPreviewEnvironment,
        VERIDIA_PACKAGED: "true",
      }),
    ).toBe(false);
    expect(
      isLocalPreviewMode({
        ...validPreviewEnvironment,
        VERIDIA_DESKTOP: "true",
      }),
    ).toBe(false);
    expect(
      isLocalPreviewMode({
        ...validPreviewEnvironment,
        NODE_ENV: "production",
      }),
    ).toBe(false);
  });

  it("缺少任一预览开关时继续使用正式认证", () => {
    expect(
      isLocalPreviewMode({
        ...validPreviewEnvironment,
        VERIDIA_LOCAL_PREVIEW: undefined,
      }),
    ).toBe(false);
    expect(
      isLocalPreviewMode({
        ...validPreviewEnvironment,
        VERIDIA_RUNTIME_KIND: undefined,
      }),
    ).toBe(false);
  });
});

describe("数据库结构错误分类", () => {
  it("识别 Prisma 字段缺失错误", () => {
    expect(isDatabaseSchemaMismatch({ code: "P2022" })).toBe(true);
    expect(
      isDatabaseSchemaMismatch(
        new Error("The column users.normalizedUsername does not exist"),
      ),
    ).toBe(true);
    expect(isDatabaseSchemaMismatch(new Error("network failed"))).toBe(false);
  });
});
