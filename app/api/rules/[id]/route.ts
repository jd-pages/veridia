import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  deleteTopicRule,
  TopicRuleManagementError,
  updateTopicRule,
} from "@/lib/topic-rule-management";

function managementFailure(error: unknown, fallback: string) {
  return error instanceof TopicRuleManagementError
    ? fail(error.message, error.statusCode)
    : fail(fallback);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rule = await updateTopicRule({
      id,
      userId: user.id,
      expectedBrandName:
        typeof body.brandName === "string" ? body.brandName.trim() : undefined,
      body,
    });
    return ok(rule);
  } catch (error) {
    return managementFailure(error, "规则数据无效");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  if (searchParams.get("mode") !== "permanent") {
    return fail("永久删除必须明确指定 mode=permanent");
  }
  try {
    return ok(
      await deleteTopicRule({
        id,
        userId: user.id,
        expectedBrandName: searchParams.get("brandName")?.trim() || undefined,
      }),
    );
  } catch (error) {
    return managementFailure(error, "规则删除失败");
  }
}
