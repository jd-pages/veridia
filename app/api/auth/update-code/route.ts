import { fail, ok } from "@/lib/api";
import { AccountCodeError } from "@/lib/accounts/codes";
import { applyAccountUpdateCode } from "@/lib/accounts/service";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    updateCode?: string;
  } | null;
  if (!body?.updateCode) return fail("账号更新码格式错误");
  try {
    return ok(await applyAccountUpdateCode(body.updateCode));
  } catch (error) {
    return fail(
      error instanceof AccountCodeError ? error.message : "账号更新码无效",
    );
  }
}
