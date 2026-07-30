import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { LOCAL_SYSTEM_USER_ID } from "@/lib/local-runtime";
import {
  AccountCodeError,
  verifyAccountCode,
} from "./codes";
import type {
  AccountActivationPayload,
  AccountUpdatePayload,
  PasswordResetPayload,
  PublicAccount,
} from "./types";
import {
  effectiveAccountStatus,
  normalizeUsername,
  parseAccountDate,
  validatePassword,
  validateUsername,
} from "./validation";
import { revokeAllUserSessions } from "@/lib/auth";

const MAX_LOGIN_FAILURES = 5;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;
const DUMMY_PASSWORD_HASH =
  "$2b$12$5kJ0PoV4gyaDvrkSeOxaM.qyIWopv1P/PmEPHhM6t2CwM1R1jHYnK";

function publicAccount(user: {
  id: string;
  accountId: string | null;
  username: string;
  displayName: string;
  role: string;
  status: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
  activatedAt: Date | null;
  lastLocalLoginAt: Date | null;
}): PublicAccount {
  return {
    id: user.id,
    accountId: user.accountId || "",
    username: user.username,
    displayName: user.displayName,
    role: user.role as PublicAccount["role"],
    status: effectiveAccountStatus(user),
    issuedAt: user.issuedAt,
    expiresAt: user.expiresAt,
    activatedAt: user.activatedAt,
    lastLocalLoginAt: user.lastLocalLoginAt,
  };
}

function assertNotExpired(expiresAt: Date | null) {
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new AccountCodeError("EXPIRED", "账号授权已经过期");
  }
}

export async function activatedAccountCount() {
  return prisma.user.count({
    where: { accountId: { not: null }, authProvider: "LOCAL_ACTIVATION" },
  });
}

export async function activateLocalAccount(code: string) {
  const { payload, digest, signature } =
    verifyAccountCode<AccountActivationPayload>(code, "ACCOUNT_ACTIVATION");
  const username = validateUsername(payload.username);
  const normalizedUsername = normalizeUsername(username);
  const issuedAt = parseAccountDate(payload.issuedAt, "签发时间")!;
  const expiresAt = parseAccountDate(payload.expiresAt, "到期时间");
  assertNotExpired(expiresAt);

  return prisma.$transaction(async (tx) => {
    if (await tx.accountCodeUse.findUnique({ where: { codeDigest: digest } })) {
      throw new AccountCodeError(
        "ALREADY_ACTIVATED",
        "账号已经在当前电脑激活",
      );
    }
    if (await tx.user.findUnique({ where: { accountId: payload.accountId } })) {
      throw new AccountCodeError(
        "ALREADY_ACTIVATED",
        "账号已经在当前电脑激活",
      );
    }
    if (
      await tx.user.findFirst({
        where: {
          OR: [{ username }, { normalizedUsername }],
          id: { not: LOCAL_SYSTEM_USER_ID },
        },
      })
    ) {
      throw new AccountCodeError("USERNAME_EXISTS", "用户名已经存在");
    }
    const placeholder = await tx.user.findFirst({
      where: {
        id: LOCAL_SYSTEM_USER_ID,
        accountId: null,
        authProvider: "LOCAL_SYSTEM",
      },
    });
    const data = {
      username,
      normalizedUsername,
      accountId: payload.accountId,
      displayName: payload.displayName.trim(),
      passwordHash: payload.passwordHash,
      role: payload.role,
      status: "ACTIVE",
      authProvider: "LOCAL_ACTIVATION",
      issuedAt,
      expiresAt,
      activatedAt: new Date(),
      activationIssuer: payload.issuer,
      activationSignature: signature,
      activationSchemaVersion: payload.schemaVersion,
      authorizationVersion: payload.authorizationVersion,
      sessionVersion: 1,
    };
    const user = placeholder
      ? await tx.user.update({ where: { id: placeholder.id }, data })
      : await tx.user.create({ data });
    await tx.accountCodeUse.create({
      data: {
        codeDigest: digest,
        codeKind: payload.kind,
        accountId: payload.accountId,
      },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "LOCAL_ACCOUNT_ACTIVATED",
        entityType: "ACCOUNT",
        entityId: user.id,
        summary: `本地账号激活成功：${payload.accountId.slice(0, 8)}…`,
        metadata: JSON.stringify({ success: true }),
      },
    });
    return publicAccount(user);
  });
}

async function recordLoginFailure(normalizedUsername: string) {
  const current = await prisma.localLoginThrottle.findUnique({
    where: { normalizedUsername },
  });
  const previousFailures =
    current?.blockedUntil && current.blockedUntil.getTime() <= Date.now()
      ? 0
      : current?.failureCount || 0;
  const failureCount = previousFailures + 1;
  await prisma.localLoginThrottle.upsert({
    where: { normalizedUsername },
    create: {
      normalizedUsername,
      failureCount,
      lastFailureAt: new Date(),
      blockedUntil:
        failureCount >= MAX_LOGIN_FAILURES
          ? new Date(Date.now() + LOGIN_BLOCK_MS)
          : null,
    },
    update: {
      failureCount,
      lastFailureAt: new Date(),
      blockedUntil:
        failureCount >= MAX_LOGIN_FAILURES
          ? new Date(Date.now() + LOGIN_BLOCK_MS)
          : null,
    },
  });
}

export async function authenticateLocalAccount(
  usernameInput: string,
  password: string,
) {
  const normalizedUsername = normalizeUsername(usernameInput);
  const throttle = await prisma.localLoginThrottle.findUnique({
    where: { normalizedUsername },
  });
  if (throttle?.blockedUntil && throttle.blockedUntil.getTime() > Date.now()) {
    if (
      throttle.blockedUntil.getTime() - Date.now() <=
      LOGIN_BLOCK_MS + 60_000
    ) {
      throw new AccountCodeError(
        "LOGIN_THROTTLED",
        "登录尝试过于频繁，请稍后再试",
      );
    }
    await prisma.localLoginThrottle.delete({
      where: { normalizedUsername },
    });
  }
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { normalizedUsername },
        { username: { equals: usernameInput.trim() } },
      ],
      authProvider: "LOCAL_ACTIVATION",
      accountId: { not: null },
    },
  });
  const passwordMatches = await bcrypt.compare(
    password,
    user?.passwordHash || DUMMY_PASSWORD_HASH,
  );
  if (!user || !passwordMatches) {
    await recordLoginFailure(normalizedUsername);
    throw new AccountCodeError(
      "INVALID_CREDENTIALS",
      "用户名或密码错误。",
    );
  }
  if (effectiveAccountStatus(user) !== "ACTIVE") {
    throw new AccountCodeError(
      user.status === "ACTIVE" ? "EXPIRED" : "DISABLED",
      user.status === "ACTIVE" ? "账号授权已经过期" : "账号已停用",
    );
  }
  const now = new Date();
  if (
    user.lastSeenClockAt &&
    now.getTime() + 5 * 60 * 1000 < user.lastSeenClockAt.getTime()
  ) {
    await prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "LOCAL_CLOCK_ROLLBACK_DETECTED",
        entityType: "ACCOUNT",
        entityId: user.id,
        summary: `检测到本地时间异常：${user.accountId!.slice(0, 8)}…`,
        metadata: JSON.stringify({ success: false, error: "CLOCK_ROLLBACK" }),
      },
    });
  }
  await prisma.$transaction([
    prisma.localLoginThrottle.deleteMany({ where: { normalizedUsername } }),
    prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: now,
        lastLocalLoginAt: now,
        lastSeenClockAt: now,
      },
    }),
    prisma.operationLog.create({
      data: {
        userId: user.id,
        action: "LOCAL_LOGIN",
        entityType: "ACCOUNT",
        entityId: user.id,
        summary: `本地账号登录成功：${user.accountId!.slice(0, 8)}…`,
        metadata: JSON.stringify({ success: true }),
      },
    }),
  ]);
  return publicAccount(user);
}

export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  nextPassword: string,
) {
  validatePassword(nextPassword);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AccountCodeError("CURRENT_PASSWORD_INVALID", "当前密码错误");
  }
  const passwordHash = await bcrypt.hash(nextPassword, 12);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, sessionVersion: { increment: 1 } },
  });
  await revokeAllUserSessions(userId);
}

export async function applyPasswordResetCode(code: string) {
  const { payload, digest } =
    verifyAccountCode<PasswordResetPayload>(code, "PASSWORD_RESET");
  const expiresAt = parseAccountDate(payload.expiresAt, "到期时间");
  if (!expiresAt) {
    throw new AccountCodeError("EXPIRY_REQUIRED", "密码重置码必须设置有效期");
  }
  assertNotExpired(expiresAt);
  if (expiresAt.getTime() - Date.now() > 7 * 24 * 60 * 60 * 1000) {
    throw new AccountCodeError(
      "EXPIRY_TOO_LONG",
      "密码重置码有效期不得超过7天",
    );
  }
  const normalizedUsername = normalizeUsername(payload.username);
  return prisma.$transaction(async (tx) => {
    if (await tx.accountCodeUse.findUnique({ where: { codeDigest: digest } })) {
      throw new AccountCodeError("CODE_USED", "密码重置码已经使用");
    }
    const user = await tx.user.findFirst({
      where: {
        accountId: payload.accountId,
        normalizedUsername,
        authProvider: "LOCAL_ACTIVATION",
      },
    });
    if (!user) throw new AccountCodeError("ACCOUNT_NOT_FOUND", "本地账号不匹配");
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: payload.passwordHash,
        sessionVersion: { increment: 1 },
      },
    });
    await tx.localAuthSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.accountCodeUse.create({
      data: {
        codeDigest: digest,
        codeKind: payload.kind,
        accountId: payload.accountId,
      },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "LOCAL_ACCOUNT_PASSWORD_RESET_CODE",
        entityType: "ACCOUNT",
        entityId: user.id,
        summary: `已应用本地密码重置码：${user.accountId!.slice(0, 8)}…`,
        metadata: JSON.stringify({ success: true }),
      },
    });
    return { username: user.username };
  });
}

export async function applyAccountUpdateCode(code: string) {
  const { payload, digest, signature } =
    verifyAccountCode<AccountUpdatePayload>(code, "ACCOUNT_UPDATE");
  const expiresAt = parseAccountDate(payload.expiresAt, "到期时间");
  return prisma.$transaction(async (tx) => {
    if (await tx.accountCodeUse.findUnique({ where: { codeDigest: digest } })) {
      throw new AccountCodeError("CODE_USED", "账号更新码已经使用");
    }
    const user = await tx.user.findUnique({
      where: { accountId: payload.accountId },
    });
    if (!user) throw new AccountCodeError("ACCOUNT_NOT_FOUND", "本地账号不匹配");
    if (normalizeUsername(user.username) !== normalizeUsername(payload.username)) {
      throw new AccountCodeError("ACCOUNT_NOT_FOUND", "本地账号不匹配");
    }
    if (payload.authorizationVersion <= user.authorizationVersion) {
      throw new AccountCodeError("VERSION_ROLLBACK", "账号更新码版本无效");
    }
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        displayName: payload.displayName.trim(),
        role: payload.role,
        expiresAt,
        status: "ACTIVE",
        authorizationVersion: payload.authorizationVersion,
        activationSignature: signature,
        activationIssuer: payload.issuer,
        sessionVersion: { increment: 1 },
      },
    });
    await tx.localAuthSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.accountCodeUse.create({
      data: {
        codeDigest: digest,
        codeKind: payload.kind,
        accountId: payload.accountId,
      },
    });
    await tx.operationLog.create({
      data: {
        userId: user.id,
        action: "LOCAL_ACCOUNT_UPDATED",
        entityType: "ACCOUNT",
        entityId: user.id,
        summary: `本地账号授权已更新：${user.accountId!.slice(0, 8)}…`,
        metadata: JSON.stringify({ success: true }),
      },
    });
    return publicAccount(updated);
  });
}

export async function hashLocalPassword(password: string) {
  return bcrypt.hash(validatePassword(password), 12);
}

export { publicAccount };
