import { requireApiUser } from "@/lib/api";
import { getActiveImportExportTemplates } from "@/lib/import-export-templates/config";
import {
  buildImportTemplateCsv,
  buildImportTemplateWorkbook,
} from "@/lib/import-export-templates/export";

export async function GET(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const format = new URL(request.url).searchParams.get("format") || "xlsx";
  const { templates } = await getActiveImportExportTemplates();
  const date = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const csv = buildImportTemplateCsv(templates);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`VERIDIA导入模板_${templates.templateVersion}_${date}.csv`)}`,
        "Cache-Control": "no-store",
      },
    });
  }
  const buffer = await buildImportTemplateWorkbook(templates);
  return new Response(new Uint8Array(buffer as ArrayBuffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`VERIDIA导入模板_${templates.templateVersion}_${date}.xlsx`)}`,
      "Cache-Control": "no-store",
    },
  });
}
