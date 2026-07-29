import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "xhs_audit_session";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
}

function secret() {
  return new TextEncoder().encode(
    process.env.AUTH_SECRET || "local-development-secret-change-me",
  );
}

function secureSessionCookie() {
  return process.env.AUTH_COOKIE_SECURE?.toLowerCase() === "true";
}

export async function createSession(user: SessionUser) {
  const token = await new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret());
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureSessionCookie(),
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      id: String(payload.id),
      username: String(payload.username),
      displayName: String(payload.displayName),
      role: String(payload.role) as SessionUser["role"],
    };
  } catch {
    return null;
  }
}

export function canManage(user: SessionUser | null) {
  return user?.role === "ADMIN";
}

export function canOperate(user: SessionUser | null) {
  return user?.role === "ADMIN" || user?.role === "OPERATOR";
}
