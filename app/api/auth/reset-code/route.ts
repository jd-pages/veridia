import { fail, ok } from "@/lib/api";
import { AccountCodeError } from "@/lib/accounts/codes";
import { applyPasswordResetCode } from "@/lib/accounts/service";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    resetCode?: string;
  } | null;
  if (!body?.resetCode) return fail("密码重置码格式错误");
  try {
    return ok(await applyPasswordResetCode(body.resetCode));
  } catch (error) {
    return fail(
      error instanceof AccountCodeError ? error.message : "密码重置码无效",
    );
  }
}
