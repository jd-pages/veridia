import { NextResponse } from "next/server";
import type { SessionUser } from "@/lib/auth";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, data }, init);
}

export function fail(error: string, status = 400) {
  return NextResponse.json({ success: false, error }, { status });
}

export async function requireApiUser(
  roles?: SessionUser["role"][],
): Promise<SessionUser | NextResponse> {
  const session = await getSession();
  if (!session) return fail("请先登录", 401);
  const currentUser = await prisma.user.findUnique({
    where: { id: session.id },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      status: true,
    },
  });
  if (!currentUser || currentUser.status !== "ACTIVE") {
    return fail("登录状态已失效，请重新登录", 401);
  }
  const user: SessionUser = {
    id: currentUser.id,
    username: currentUser.username,
    displayName: currentUser.displayName,
    role: currentUser.role as SessionUser["role"],
  };
  if (roles && !roles.includes(user.role)) return fail("没有操作权限", 403);
  return user;
}
