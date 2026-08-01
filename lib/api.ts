import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/auth";
import { getSession } from "@/lib/auth";
import { isDatabaseSchemaMismatch } from "@/lib/database-errors";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, ok: true, data }, init);
}

export function fail(error: string, status = 400, code = "REQUEST_FAILED") {
  return NextResponse.json(
    {
      success: false,
      ok: false,
      error,
      errorDetail: { code, message: error },
    },
    { status },
  );
}

export function withApiErrorBoundary<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<Response> | Response,
  operation = "处理请求",
) {
  return async (...args: TArgs): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error(`[VERIDIA API] ${operation}失败`, error);
      if (isDatabaseSchemaMismatch(error)) {
        return fail(
          "本地数据库结构需要升级，请完全退出并重新启动 VERIDIA 后再试。",
          503,
          "DATABASE_SCHEMA_OUTDATED",
        );
      }
      return fail(
        "数据读取失败，请刷新或重启 VERIDIA。",
        500,
        "INTERNAL_SERVER_ERROR",
      );
    }
  };
}

export async function requireApiUser(
  roles?: SessionUser["role"][],
): Promise<SessionUser | NextResponse> {
  const user = await getSession();
  if (!user) {
    return fail("登录状态已失效，请重新登录。", 401, "UNAUTHENTICATED");
  }
  if (roles && !roles.includes(user.role)) {
    return fail(
      "当前账号无此操作权限，请联系管理员。",
      403,
      "PERMISSION_DENIED",
    );
  }
  return user;
}
