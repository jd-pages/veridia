import { prisma } from "@/lib/db";
import { requireApiUser } from "@/lib/api";
import { businessStatusLabel } from "@/lib/zh-CN";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  buildConfiguredCsv,
  buildConfiguredWorkbook,
  type ExportValueRecord,
} from "@/lib/import-export-templates/export";

export async function GET(request: Request) {
  const user = await requireApiUser(["ADMIN", "OPERATOR", "VIEWER"]);
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId") || undefined;
  const tasks = await prisma.auditTask.findMany({
    where: batchId ? { batchId } : {},
    include: {
      product: { select: { name: true } },
      campaign: { select: { name: true } },
      auditResults: {
        orderBy: { auditedAt: "desc" },
        take: 1,
        select: {
          autoStatus: true,
          rulePackageVersion: true,
          auditedAt: true,
          note: { select: { platformNoteId: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const { templates } = await getActiveImportExportTemplates();
  const records: ExportValueRecord[] = tasks.map((task) => {
    const result = task.auditResults[0];
    return {
      noteUrl: task.url,
      noteId: result?.note.platformNoteId || "",
      productName: task.product.name,
      activityName: task.campaign.name,
      auditStatus: businessStatusLabel(task.status, "process"),
      auditResult: result
        ? businessStatusLabel(result.autoStatus, "audit")
        : "暂无结论",
      ruleVersion: result?.rulePackageVersion || task.rulePackageVersion || "",
      reviewedAt: result?.auditedAt || "",
      remark: task.notes || "",
    };
  });
  const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const name = `VERIDIA审核任务_${new Date().toISOString().slice(0, 10)}`;
  if (format === "csv") {
    return new Response(
      buildConfiguredCsv({ templates, kind: "auditTasks", records }),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.csv`)}`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
  const bytes = await buildConfiguredWorkbook({
    templates,
    kind: "auditTasks",
    records,
  });
  return new Response(new Uint8Array(bytes as ArrayBuffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.xlsx`)}`,
      "Cache-Control": "no-store",
    },
  });
}
