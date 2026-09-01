import { fail, ok, requireApiUser } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  deleteMonthlyTopicRules,
  normalizeMonthlyTopicRuleDeletionInput,
  TopicRuleManagementError,
} from "@/lib/topic-rule-management";

export async function DELETE(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  try {
    const scope = normalizeMonthlyTopicRuleDeletionInput(await request.json());
    return ok(await deleteMonthlyTopicRules({ ...scope, userId: user.id }));
  } catch (error) {
    return error instanceof TopicRuleManagementError
      ? fail(error.message, error.statusCode)
      : fail("本月话题规则删除失败");
  }
}
