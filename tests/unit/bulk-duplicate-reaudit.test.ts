import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) =>
  readFileSync(path.join(process.cwd(), file), "utf8");

describe("历史重复批量确认基础设施", () => {
  it("同时保留单条、多选与完整集合的一键确认入口", () => {
    const page = source("app/(admin)/tasks/page.tsx");
    expect(page).toContain("仍然新增并重新审核");
    expect(page).toContain("批量确认重复并重审");
    expect(page).toContain("确认全部重复项并继续");
    expect(page).toContain('confirmAllDuplicateReaudits');
    expect(page).toContain('row.duplicateWarning?.kind !== "HISTORICAL"');
  });

  it("服务端只批量确认真实历史重复，并保留其他 errors 门禁", () => {
    const route = source("app/api/import/notes/route.ts");
    expect(route).toContain("isHistoricalDuplicate && confirmAllDuplicateReaudits");
    expect(route).toContain('row.duplicateWarning?.kind === "HISTORICAL"');
    expect(route).toContain("row.errors.length === 0");
    expect(route).toContain("BULK_DUPLICATE_REAUDIT_CONFIRM");
    expect(route).toContain("confirmationCount: duplicateConfirmations.length");
  });

  it("Import requestKey 唯一约束使提交重试复用原批次和日志", () => {
    const route = source("app/api/import/notes/route.ts");
    expect(source("prisma/schema.prisma")).toContain(
      "requestKey          String?      @unique",
    );
    expect(route).toContain("where: { requestKey }");
    expect(route).toContain("alreadyCommitted: true");
    expect(route).toContain('error.code === "P2002"');
  });
});
