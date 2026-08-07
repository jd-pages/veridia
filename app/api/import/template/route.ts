import { requireApiUser } from "@/lib/api";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import { buildImportTemplateWorkbook } from "@/lib/import-export-templates/export";
import { KABRITA_BRAND_NAME } from "@/lib/import-export-templates/kabrita";
import type { ImportTemplateType } from "@/lib/import-template-type";
import { prisma } from "@/lib/db";

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const searchParams = new URL(request.url).searchParams;
  const format = searchParams.get("format") || "xlsx";
  if (format !== "xlsx") {
    return new Response("仅支持 Excel（.xlsx）模板", { status: 400 });
  }
  const requestedBrand = searchParams.get("brand");
  const templateBrand = requestedBrand === "kabrita"
    ? KABRITA_BRAND_NAME
    : undefined;
  const templateType: ImportTemplateType = requestedBrand === "kabrita"
    ? "KABRITA"
    : requestedBrand === "danone-agency"
      ? "DANONE_AGENCY"
      : "DANONE_CUSTOMER";
  const { templates } = await getActiveImportExportTemplates();
  const activities = await prisma.campaign.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
    select: { name: true, contentChannel: true },
  });
  const date = new Date().toISOString().slice(0, 10);
  const buffer = await buildImportTemplateWorkbook(templates, {
    templateBrand,
    templateType,
    activities: activities.map((campaign) => ({
      name: campaign.name,
      contentChannel: campaign.contentChannel === "DOUYIN"
        ? "DOUYIN" as const
        : "XIAOHONGSHU" as const,
    })),
  });
  const templateLabel = templateType === "DANONE_AGENCY"
    ? "达能代发"
    : templateType === "DANONE_CUSTOMER"
      ? "达能客户"
      : "佳贝艾特";
  return new Response(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`VERIDIA${templateLabel}导入模板_${templates.templateVersion}_${date}.xlsx`)}`,
      "Cache-Control": "no-store",
    },
  });
}
