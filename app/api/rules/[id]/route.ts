import { prisma } from "@/lib/db";
import { normalizeTopic } from "@/lib/topic";
import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await request.json()) as Record<string, unknown>;
  const existing = await prisma.topicRule.findUnique({ where: { id } });
  if (!existing) return fail("规则不存在", 404);
  if (
    typeof body.brandName === "string" &&
    body.brandName.trim() !== existing.brandName
  ) {
    return fail("规则不属于当前品牌", 403);
  }
  try {
    const rule = await prisma.$transaction(async (tx) => {
      let version = existing.version + 1;
      if (existing.campaignId) {
        const campaign = await tx.campaign.update({
          where: { id: existing.campaignId },
          data: { ruleVersion: { increment: 1 } },
        });
        version = campaign.ruleVersion;
      }
      return tx.topicRule.update({
        where: { id },
        data: {
          ruleSource: "LOCAL_DRAFT",
          ...(typeof body.ruleType === "string" ? { ruleType: body.ruleType } : {}),
          ...(typeof body.topic === "string"
            ? { topic: normalizeTopic(body.topic) }
            : {}),
          ...(typeof body.exactMatch === "boolean"
            ? { exactMatch: body.exactMatch }
            : {}),
          ...(typeof body.clickableRequired === "boolean"
            ? { clickableRequired: body.clickableRequired }
            : {}),
          ...(typeof body.caseSensitive === "boolean"
            ? { caseSensitive: body.caseSensitive }
            : {}),
          ...(typeof body.minCount === "number" ? { minCount: body.minCount } : {}),
          ...(typeof body.sortOrder === "number"
            ? { sortOrder: body.sortOrder }
            : {}),
          ...(typeof body.status === "string" ? { status: body.status } : {}),
          ...(typeof body.notes === "string" ? { notes: body.notes.trim() } : {}),
          version,
        },
        include: { campaign: true, product: true },
      });
    });
    return ok(rule);
  } catch {
    return fail("规则数据无效");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const existing = await prisma.topicRule.findUnique({ where: { id } });
  if (!existing) return fail("规则不存在", 404);
  const brandName = new URL(request.url).searchParams.get("brandName")?.trim();
  if (brandName && brandName !== existing.brandName) {
    return fail("规则不属于当前品牌", 403);
  }
  const rule = await prisma.$transaction(async (tx) => {
    if (existing.campaignId) {
      await tx.campaign.update({
        where: { id: existing.campaignId },
        data: { ruleVersion: { increment: 1 } },
      });
    }
    return tx.topicRule.update({
      where: { id },
      data: { status: "INACTIVE", ruleSource: "LOCAL_DRAFT" },
    });
  });
  return ok(rule);
}
