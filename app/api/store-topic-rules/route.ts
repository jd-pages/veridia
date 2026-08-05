import { fail, ok, requireApiUser, withApiErrorBoundary } from "@/lib/api";
import { BUSINESS_ROLES } from "@/lib/permissions";
import {
  createStoreTopicRule,
  listStoreTopicRules,
} from "@/lib/store-topic-rule-service";

export const GET = withApiErrorBoundary(async function GET(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  const { searchParams } = new URL(request.url);
  return ok(await listStoreTopicRules({
    commercePlatform: searchParams.get("commercePlatform"),
    query: searchParams.get("query"),
    status: searchParams.get("status"),
    page: searchParams.get("page"),
    pageSize: searchParams.get("pageSize"),
  }));
}, "读取店铺话题规则");

export async function POST(request: Request) {
  const user = await requireApiUser(BUSINESS_ROLES);
  if (user instanceof Response) return user;
  try {
    return ok(await createStoreTopicRule(await request.json(), user), {
      status: 201,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "新增店铺规则失败");
  }
}
