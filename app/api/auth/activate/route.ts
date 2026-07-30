import { fail, ok } from "@/lib/api";
import { AccountCodeError } from "@/lib/accounts/codes";
import {
  activateLocalAccount,
  inspectLocalAccountActivation,
} from "@/lib/accounts/service";
import { validatePassword } from "@/lib/accounts/validation";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    activationCode?: string;
    preview?: boolean;
    password?: string;
    confirmPassword?: string;
  } | null;
  if (!body?.activationCode) return fail("账号激活码格式错误。");
  try {
    const preview = inspectLocalAccountActivation(body.activationCode);
    if (body.preview) return ok(preview);
    if (preview.requiresPassword) {
      if (!body.password || !body.confirmPassword) {
        return fail("请设置并确认本地登录密码。");
      }
      if (body.password !== body.confirmPassword) {
        return fail("两次输入的密码不一致。");
      }
      validatePassword(body.password);
    }
    return ok(
      await activateLocalAccount(body.activationCode, body.password),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof AccountCodeError) return fail(error.message);
    return fail(
      error instanceof Error ? error.message : "账号激活码无效。",
    );
  }
}
