import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import {
  CampaignProductStageConfigurationError,
  resolveCampaignProductStageConfiguration,
} from "@/lib/campaign-product-stage";
import { parseAutomationPlatform } from "@/lib/automation/platform";

export const GET = withApiErrorBoundary(async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get("productId")?.trim() || "";
  const contentChannel = parseAutomationPlatform(
    searchParams.get("contentChannel"),
  );
  if (!productId) return fail("请选择产品");
  if (!contentChannel) return fail("请选择内容平台");
  let configuration;
  try {
    configuration = await resolveCampaignProductStageConfiguration({
      campaignId: id,
      productId,
      contentChannel,
    });
  } catch (error) {
    if (error instanceof CampaignProductStageConfigurationError) {
      return fail(error.message, error.status, error.code);
    }
    throw error;
  }
  return ok({
    requiresProductStage: configuration.requiresProductStage,
    options: configuration.stageOptions,
  }, { headers: { "Cache-Control": "no-store" } });
}, "读取产品所属阶段");
