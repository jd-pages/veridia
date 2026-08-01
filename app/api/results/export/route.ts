import { prisma } from "@/lib/db";
import { fail, requireApiUser } from "@/lib/api";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  auditResultToExportRecord,
  buildConfiguredCsv,
  buildConfiguredWorkbook,
} from "@/lib/import-export-templates/export";
import { backfillMissingProcessingFailureResults } from "@/lib/processing-failure-result";
import {
  buildAuditResultWhere,
  readResultQueryFilters,
} from "@/lib/result-query";

export async function GET(request: Request) {
  const user = await requireApiUser(["ADMIN", "OPERATOR"]);
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const filters = readResultQueryFilters(searchParams);
  await backfillMissingProcessingFailureResults();
  let where;
  try {
    where = buildAuditResultWhere(
      filters,
    );
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "筛选条件不正确",
      400,
    );
  }
  const rows = await prisma.auditResult.findMany({
    where,
    include: {
      note: {
        include: {
          topics: {
            select: {
              displayText: true,
              isClickable: true,
              isLinkElement: true,
              hasHref: true,
              href: true,
              styleFeature: true,
            },
          },
        },
      },
      task: { include: { product: true, campaign: true } },
      manualReviews: { orderBy: { createdAt: "desc" }, take: 1 },
      ruleResults: {
        select: { ruleName: true, passed: true },
      },
    },
    orderBy: { auditedAt: "desc" },
  });
  if (!rows.length) {
    console.info(
      "[审核结果导出] 未生成文件",
      JSON.stringify({
        count: 0,
        filterKeys: Object.entries(filters)
          .filter(([, value]) =>
            Array.isArray(value) ? value.length > 0 : Boolean(value),
          )
          .map(([key]) => key),
      }),
    );
    return fail(
      "当前筛选无结果，未生成文件",
      404,
      "NO_EXPORT_RESULTS",
    );
  }
  const { templates } = await getActiveImportExportTemplates();
  const records = rows.map((row) =>
    auditResultToExportRecord(row, templates, {
      dateType: searchParams.get("dateType") || "AUDITED_AT",
    }),
  );
  const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const now = new Date();
  const dateStamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const baseName = `VERIDIA审核结果_当前筛选_${dateStamp}`;
  const exportLog = (format: "csv" | "xlsx", bytes: number) =>
    console.info(
      "[审核结果导出] 文件生成完成",
      JSON.stringify({
        count: rows.length,
        format,
        bytes,
        filterKeys: Object.entries(filters)
          .filter(([, value]) =>
            Array.isArray(value) ? value.length > 0 : Boolean(value),
          )
          .map(([key]) => key),
      }),
    );
  if (format === "csv") {
    const csv = buildConfiguredCsv({
      templates,
      kind: "auditResults",
      records,
    });
    const byteLength = new TextEncoder().encode(csv).byteLength;
    if (byteLength < 1) {
      return fail("导出文件生成异常，请稍后重试", 500, "EMPTY_EXPORT_FILE");
    }
    exportLog("csv", byteLength);
    return new Response(
      csv,
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.csv`)}`,
          "Cache-Control": "no-store",
          "X-Veridia-Export-Count": String(rows.length),
        },
      },
    );
  }
  const buffer = await buildConfiguredWorkbook({
    templates,
    kind: "auditResults",
    records,
  });
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  if (bytes.byteLength < 1_024) {
    return fail("导出文件生成异常，请稍后重试", 500, "EMPTY_EXPORT_FILE");
  }
  exportLog("xlsx", bytes.byteLength);
  return new Response(bytes, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.xlsx`)}`,
      "Cache-Control": "no-store",
      "X-Veridia-Export-Count": String(rows.length),
    },
  });
}
