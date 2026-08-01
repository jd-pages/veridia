import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { effectiveAccountStatus } from "@/lib/accounts/validation";
import type { LocalAccountRole } from "@/lib/accounts/types";
import { ensureLocalPreviewRuntime } from "@/lib/local-runtime";

const COOKIE_NAME = "veridia_local_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;

export interface SessionUser {
  id: string;
  accountId: string;
  username: string;
  displayName: string;
  role: LocalAccountRole;
  expiresAt: string | null;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function secureSessionCookie() {
  return process.env.AUTH_COOKIE_SECURE?.toLowerCase() === "true";
}

function toSessionUser(user: {
  id: string;
  accountId: string | null;
  username: string;
  displayName: string;
  role: string;
  expiresAt: Date | null;
}): SessionUser {
  return {
    id: user.id,
    accountId: user.accountId || "",
    username: user.username,
    displayName: user.displayName,
    role: user.role as LocalAccountRole,
    expiresAt: user.expiresAt?.toISOString() || null,
  };
}

async function lookupToken(token: string) {
  if (!token || token.length < 40) return null;
  const session = await prisma.localAuthSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true },
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= Date.now() ||
    session.sessionVersion !== session.user.sessionVersion ||
    !session.user.accountId ||
    session.user.authProvider !== "LOCAL_ACTIVATION" ||
    effectiveAccountStatus(session.user) !== "ACTIVE"
  ) {
    return null;
  }
  return toSessionUser(session.user);
}

export async function createSession(user: SessionUser) {
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const token = randomBytes(32).toString("base64url");
  const maximumExpiry = new Date(
    Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  );
  const expiresAt =
    current.expiresAt && current.expiresAt < maximumExpiry
      ? current.expiresAt
      : maximumExpiry;
  await prisma.localAuthSession.create({
    data: {
      userId: current.id,
      tokenHash: tokenHash(token),
      sessionVersion: current.sessionVersion,
      expiresAt,
    },
  });
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureSessionCookie(),
    path: "/",
    maxAge: Math.max(
      1,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    ),
  });
  return { persistentToken: token, user: toSessionUser(current) };
}

export async function clearSession() {
  const cookieStore = await cookies();
  const tokens = [
    cookieStore.get(COOKIE_NAME)?.value,
    process.env.VERIDIA_PERSISTENT_SESSION_TOKEN,
  ].filter(Boolean) as string[];
  if (tokens.length) {
    await prisma.localAuthSession.updateMany({
      where: {
        tokenHash: { in: tokens.map(tokenHash) },
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }
  cookieStore.delete(COOKIE_NAME);
}

export async function revokeAllUserSessions(userId: string) {
  await prisma.localAuthSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getSession(): Promise<SessionUser | null> {
  const previewUser = await ensureLocalPreviewRuntime();
  if (previewUser) return previewUser;

  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(COOKIE_NAME)?.value;
  if (cookieToken) {
    const user = await lookupToken(cookieToken);
    if (user) return user;
  }
  const persistentToken = process.env.VERIDIA_PERSISTENT_SESSION_TOKEN;
  return persistentToken ? lookupToken(persistentToken) : null;
}

export function canManage(user: SessionUser | null) {
  return user?.role === "ADMIN";
}

export function canOperate(user: SessionUser | null) {
  return user?.role === "ADMIN" || user?.role === "OPERATOR";
}
