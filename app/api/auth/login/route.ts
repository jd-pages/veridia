import { createSession } from "@/lib/auth";
import { fail, ok } from "@/lib/api";
import {
  AccountCodeError,
} from "@/lib/accounts/codes";
import { authenticateLocalAccount } from "@/lib/accounts/service";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    username?: string;
    password?: string;
  } | null;
  if (!body?.username || !body.password) {
    return fail("用户名或密码错误。", 401);
  }
  try {
    const account = await authenticateLocalAccount(
      body.username,
      body.password,
    );
    const session = await createSession({
      id: account.id,
      accountId: account.accountId,
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      expiresAt: account.expiresAt?.toISOString() || null,
    });
    return ok(session);
  } catch (error) {
    if (
      error instanceof AccountCodeError &&
      ["LOGIN_THROTTLED", "EXPIRED", "DISABLED"].includes(error.code)
    ) {
      return fail(error.message, error.code === "LOGIN_THROTTLED" ? 429 : 403);
    }
    return fail("用户名或密码错误。", 401);
  }
}
