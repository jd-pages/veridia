import { getSession } from "@/lib/auth";
import { fail, ok } from "@/lib/api";

export async function GET() {
  const user = await getSession();
  return user ? ok(user) : fail("未登录", 401);
}
