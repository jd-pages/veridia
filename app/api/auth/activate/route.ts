import { fail, ok } from "@/lib/api";
import { AccountCodeError } from "@/lib/accounts/codes";
import { activateLocalAccount } from "@/lib/accounts/service";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    activationCode?: string;
  } | null;
  if (!body?.activationCode) return fail("账号激活码格式错误");
  try {
    return ok(await activateLocalAccount(body.activationCode), { status: 201 });
  } catch (error) {
    if (error instanceof AccountCodeError) return fail(error.message);
    return fail("账号激活码无效");
  }
}
