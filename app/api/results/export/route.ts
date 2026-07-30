import { prisma } from "@/lib/db";
import { requireApiUser } from "@/lib/api";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  auditResultToExportRecord,
  buildConfiguredCsv,
  buildConfiguredWorkbook,
} from "@/lib/import-export-templates/export";

export async function GET(request: Request) {
  const user = await requireApiUser(["ADMIN", "OPERATOR"]);
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId") || undefined;
  const campaignId = searchParams.get("campaignId") || undefined;
  const month = searchParams.get("month") || undefined;
  const status = searchParams.get("status") || undefined;
  const imageStatus = searchParams.get("imageStatus") || undefined;
  const reason = searchParams.get("reason")?.trim() || undefined;
  const keyword = searchParams.get("keyword")?.trim() || undefined;
  const rows = await prisma.auditResult.findMany({
    where: {
      ...(status ? { autoStatus: status } : {}),
      ...(imageStatus ? { imageStatus } : {}),
      ...(reason ? { failureReasons: { contains: reason } } : {}),
      task: {
        ...(productId ? { productId } : {}),
        ...(campaignId ? { campaignId } : {}),
        ...(month ? { campaign: { month } } : {}),
      },
      ...(keyword
        ? {
            OR: [
              { note: { title: { contains: keyword } } },
              { note: { body: { contains: keyword } } },
              { note: { url: { contains: keyword } } },
            ],
          }
        : {}),
    },
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
  const { templates } = await getActiveImportExportTemplates();
  const records = rows.map((row) =>
    auditResultToExportRecord(row, templates),
  );
  const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const taskName = rows[0]?.task.campaign.name || "全部任务";
  const safeTaskName = taskName.replace(/[\\/:*?"<>|]/gu, "_").slice(0, 40);
  const baseName = `VERIDIA审核结果_${safeTaskName}_${new Date()
    .toISOString()
    .slice(0, 10)}`;
  if (format === "csv") {
    return new Response(
      buildConfiguredCsv({ templates, kind: "auditResults", records }),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.csv`)}`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
  const buffer = await buildConfiguredWorkbook({
    templates,
    kind: "auditResults",
    records,
  });
  return new Response(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.xlsx`)}`,
      "Cache-Control": "no-store",
    },
  });
}
