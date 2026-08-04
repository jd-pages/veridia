import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  buildCampaignImportPreview,
  commitCampaignRuleImport,
  parseCampaignRuleWorkbook,
  type CampaignImportMetadata,
} from "@/lib/rule-import";

export async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const form = await request.formData();
  const file = form.get("file");
  const commit = form.get("commit") === "true";
  if (!(file instanceof File)) return fail("请选择规则 Excel 文件");
  if (file.size > 10 * 1024 * 1024) return fail("文件不能超过 10MB");

  let metadata: CampaignImportMetadata;
  try {
    metadata = JSON.parse(
      String(form.get("metadata") || "{}"),
    ) as CampaignImportMetadata;
  } catch {
    return fail("活动信息格式不正确");
  }
  try {
    const normalized = await parseCampaignRuleWorkbook(file, metadata);
    const preview = await buildCampaignImportPreview(normalized);
    if (!commit) return ok(preview);
    const imported = await commitCampaignRuleImport(
      normalized,
      file.name,
      user.id,
    );
    return ok({
      ...preview,
      imported: {
        campaignId: imported.campaign.id,
        campaignName: imported.campaign.name,
        products: imported.products.length,
        topicRules: normalized.topicRules.length,
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "规则 Excel 解析失败");
  }
}
