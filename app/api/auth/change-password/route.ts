import { clearSession } from "@/lib/auth";
import { fail, ok, requireApiUser } from "@/lib/api";
import { AccountCodeError } from "@/lib/accounts/codes";
import { changeOwnPassword } from "@/lib/accounts/service";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const body = (await request.json().catch(() => null)) as {
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  } | null;
  if (
    !body?.currentPassword ||
    !body.newPassword ||
    body.newPassword !== body.confirmPassword
  ) {
    return fail("请完整填写密码，且两次新密码必须一致");
  }
  try {
    await changeOwnPassword(user.id, body.currentPassword, body.newPassword);
    await clearSession();
    return ok({ clearPersistentSession: true });
  } catch (error) {
    return fail(
      error instanceof AccountCodeError || error instanceof Error
        ? error.message
        : "修改密码失败",
    );
  }
}
