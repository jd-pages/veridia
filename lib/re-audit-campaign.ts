import { prisma } from "@/lib/db";
import {
  resolveTaskAutomationPlatform,
  type AutomationPlatform,
} from "@/lib/automation/platform";

interface ReauditTaskCampaignReference {
  campaignId: string;
  productId: string;
  url: string;
  channel: string | null;
  platform: string | null;
}

function channelMatches(
  campaignChannel: string,
  taskChannel: AutomationPlatform,
) {
  return campaignChannel === taskChannel || campaignChannel === "ALL";
}

export async function resolveReauditCampaignId(
  task: ReauditTaskCampaignReference,
) {
  const taskChannel = resolveTaskAutomationPlatform(task);
  if (!taskChannel) throw new Error("重新审核记录未关联有效内容平台");
  const source = await prisma.campaign.findUnique({
    where: { id: task.campaignId },
    select: {
      id: true,
      publishedKey: true,
      name: true,
      month: true,
      contentChannel: true,
    },
  });
  if (!source) throw new Error("重新审核记录关联的原活动不存在");
  if (channelMatches(source.contentChannel, taskChannel)) return source.id;

  const expectedName = taskChannel === "DOUYIN"
    ? source.name.replace("小红书", "抖音")
    : source.name.replace("抖音", "小红书");
  const sourceKey = source.publishedKey?.replace(/^douyin_/u, "") || null;
  const expectedKey = sourceKey
    ? taskChannel === "DOUYIN"
      ? `douyin_${sourceKey}`
      : sourceKey
    : null;
  const candidates = await prisma.campaign.findMany({
    where: {
      contentChannel: taskChannel,
      month: source.month,
      status: "ACTIVE",
      deletedAt: null,
      OR: [
        ...(expectedKey ? [{ publishedKey: expectedKey }] : []),
        { name: expectedName },
      ],
      AND: [
        {
          OR: [
            { productId: task.productId },
            { products: { some: { productId: task.productId } } },
          ],
        },
      ],
    },
    select: { id: true },
  });
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length
        ? "存在多个可用于重新审核的同渠道活动，请先修正活动配置"
        : "未找到可用于重新审核的同渠道活动，请先初始化对应平台规则",
    );
  }
  return candidates[0].id;
}
