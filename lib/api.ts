import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/auth";
import { getSession } from "@/lib/auth";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, data }, init);
}

export function fail(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

export async function requireApiUser(
  roles?: SessionUser["role"][],
): Promise<SessionUser | NextResponse> {
  const user = await getSession();
  if (!user) return fail("登录状态已失效，请重新登录", 401);
  if (roles && !roles.includes(user.role)) {
    return fail("没有操作权限", 403);
  }
  return user;
}
