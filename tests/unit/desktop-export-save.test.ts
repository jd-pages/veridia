import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createExportSaveHandler } = require(
  "../../desktop/export-save.cjs",
) as {
  createExportSaveHandler(dependencies: {
    app: { getPath(name: string): string };
    dialog: { showSaveDialog: ReturnType<typeof vi.fn> };
    fs: { promises: { writeFile: ReturnType<typeof vi.fn> } };
    path: typeof path;
    getWindow(): unknown;
    writeLog: ReturnType<typeof vi.fn>;
  }): (
    event: unknown,
    payload: {
      fileName: string;
      data: Uint8Array;
      kind?: "audit-export" | "import-template";
    },
  ) => Promise<{
    success: boolean;
    canceled?: boolean;
    error?: string;
  }>;
};

describe("Electron 审核结果保存", () => {
  it("连续触发五次时只显示一次保存对话框并只写入一个文件", async () => {
    let finishDialog: ((value: { canceled: boolean; filePath: string }) => void) | undefined;
    const showSaveDialog = vi.fn(
      () =>
        new Promise<{ canceled: boolean; filePath: string }>((resolve) => {
          finishDialog = resolve;
        }),
    );
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const handler = createExportSaveHandler({
      app: { getPath: () => "C:\\Exports" },
      dialog: { showSaveDialog },
      fs: { promises: { writeFile } },
      path,
      getWindow: () => ({}),
      writeLog: vi.fn(),
    });
    const payload = {
      fileName: "VERIDIA审核结果_当前筛选_2026-08-01.xlsx",
      data: new Uint8Array(2_048),
    };

    const attempts = Array.from({ length: 5 }, () => handler(null, payload));
    await Promise.resolve();
    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    finishDialog?.({
      canceled: false,
      filePath: "C:\\Exports\\result.xlsx",
    });
    const results = await Promise.all(attempts);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toHaveLength(4);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("拒绝空文件且不打开保存对话框", async () => {
    const showSaveDialog = vi.fn();
    const handler = createExportSaveHandler({
      app: { getPath: () => "C:\\Exports" },
      dialog: { showSaveDialog },
      fs: { promises: { writeFile: vi.fn() } },
      path,
      getWindow: () => ({}),
      writeLog: vi.fn(),
    });
    const result = await handler(null, {
      fileName: "empty.xlsx",
      data: new Uint8Array(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("内容为空");
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it("导入模板复用原生保存流程并使用模板文件名和对话框", async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: "C:\\Exports\\VERIDIA导入模板.xlsx",
    });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const handler = createExportSaveHandler({
      app: { getPath: () => "C:\\Exports" },
      dialog: { showSaveDialog },
      fs: { promises: { writeFile } },
      path,
      getWindow: () => ({}),
      writeLog: vi.fn(),
    });

    const result = await handler(null, {
      fileName: "VERIDIA导入模板_2026-08-02.xlsx",
      data: new Uint8Array([1, 2, 3]),
      kind: "import-template",
    });

    expect(result.success).toBe(true);
    expect(showSaveDialog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        title: "保存 VERIDIA 导入模板",
        defaultPath: expect.stringContaining("VERIDIA导入模板_2026-08-02.xlsx"),
      }),
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});
