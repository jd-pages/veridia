import { fail, requireApiUser } from "@/lib/api";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  buildImportTemplateWorkbook,
  buildUnifiedImportTemplateWorkbook,
} from "@/lib/import-export-templates/export";
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
  if (
    requestedBrand &&
    requestedBrand !== "danone-customer" &&
    requestedBrand !== "kabrita"
  ) {
    return fail("导入模板不存在", 404);
  }
  const legacyRequest = Boolean(requestedBrand);
  const templateBrand = requestedBrand === "kabrita"
    ? KABRITA_BRAND_NAME
    : undefined;
  const templateType: ImportTemplateType = requestedBrand === "kabrita"
    ? "KABRITA"
    : "DANONE_CUSTOMER";
  const { templates } = await getActiveImportExportTemplates();
  const [activities, products] = await Promise.all([
    prisma.campaign.findMany({
      where: { status: "ACTIVE", deletedAt: null },
      orderBy: [{ startDate: "desc" }, { name: "asc" }],
      select: { name: true, contentChannel: true },
    }),
    prisma.product.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        brandName: { in: ["惠氏", "雀巢"] },
      },
      orderBy: [{ brandName: "asc" }, { name: "asc" }],
      select: { id: true, code: true, name: true, brandName: true },
    }),
  ]);
  const normalizedActivities = activities.map((campaign) => ({
      name: campaign.name,
      contentChannel: campaign.contentChannel === "DOUYIN"
        ? "DOUYIN" as const
        : "XIAOHONGSHU" as const,
    }));
  const buffer = legacyRequest
    ? await buildImportTemplateWorkbook(templates, {
        templateBrand,
        templateType,
        activities: normalizedActivities,
      })
    : await buildUnifiedImportTemplateWorkbook(templates, {
        activities: normalizedActivities,
        products,
      });
  const templateLabel = templateType === "DANONE_CUSTOMER"
      ? "达能客户"
      : "佳贝艾特";
  return new Response(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
        legacyRequest
          ? `VERIDIA${templateLabel}导入模板_${templates.templateVersion}.xlsx`
          : "VERIDIA审核导入模板.xlsx",
      )}`,
      "Cache-Control": "no-store",
    },
  });
}
