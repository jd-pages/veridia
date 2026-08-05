import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  deleteStoreTopicRule,
  updateStoreTopicRule,
} from "@/lib/store-topic-rule-service";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  try {
    const { id } = await context.params;
    return ok(await updateStoreTopicRule(id, await request.json(), user));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "更新店铺规则失败");
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  try {
    const { id } = await context.params;
    return ok(await deleteStoreTopicRule(id, user));
  } catch (error) {
    return fail(error instanceof Error ? error.message : "删除店铺规则失败");
  }
}
