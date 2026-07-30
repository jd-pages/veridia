import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_CODE_KINDS,
  type AccountCodeKind,
  type AccountCodePayload,
} from "./types";
import {
  parseAccountDate,
  validatePasswordHash,
  validateRole,
  validateUsername,
} from "./validation";

const CODE_PREFIX = "VRD1";
const PUBLIC_KEY_FILE = "account-signing-ed25519-public.pem";

export class AccountCodeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function publicKeyCandidates() {
  const configured = process.env.VERIDIA_ACCOUNT_SIGNING_PUBLIC_KEY_PATH?.trim();
  return [
    configured,
    path.join(process.cwd(), "config", PUBLIC_KEY_FILE),
    path.resolve(process.cwd(), "..", "..", "config", PUBLIC_KEY_FILE),
  ].filter(Boolean) as string[];
}

export function accountSigningPublicKeyPath() {
  return publicKeyCandidates().find((candidate) => fs.existsSync(candidate));
}

function readPublicKey() {
  const keyPath = accountSigningPublicKeyPath();
  if (!keyPath) {
    throw new AccountCodeError(
      "PUBLIC_KEY_UNAVAILABLE",
      "当前软件无法验证该账号",
    );
  }
  return createPublicKey(fs.readFileSync(keyPath, "utf8"));
}

function decodePart(value: string) {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new AccountCodeError("FORMAT_INVALID", "账号激活码格式错误");
  }
}

function validateCommonPayload(
  value: unknown,
  expectedKind: AccountCodeKind,
): AccountCodePayload {
  if (!value || typeof value !== "object") {
    throw new AccountCodeError("INCOMPLETE", "账号信息不完整");
  }
  const payload = value as Partial<AccountCodePayload>;
  if (payload.schemaVersion !== 1) {
    throw new AccountCodeError(
      "SCHEMA_INCOMPATIBLE",
      "账号版本与当前软件不兼容",
    );
  }
  if (
    payload.kind !== expectedKind ||
    !ACCOUNT_CODE_KINDS.includes(payload.kind as AccountCodeKind)
  ) {
    throw new AccountCodeError("KIND_INVALID", "账号激活码无效");
  }
  if (
    typeof payload.accountId !== "string" ||
    payload.accountId.length < 8 ||
    typeof payload.username !== "string" ||
    typeof payload.issuedAt !== "string" ||
    typeof payload.issuer !== "string" ||
    !payload.issuer.trim() ||
    !Number.isSafeInteger(payload.authorizationVersion) ||
    Number(payload.authorizationVersion) < 1 ||
    Number(payload.authorizationVersion) > 2_147_483_647
  ) {
    throw new AccountCodeError("INCOMPLETE", "账号信息不完整");
  }
  try {
    validateUsername(payload.username);
    parseAccountDate(payload.issuedAt, "签发时间");
    parseAccountDate(payload.expiresAt ?? null, "到期时间");
    if (
      payload.kind === "ACCOUNT_ACTIVATION" ||
      payload.kind === "PASSWORD_RESET"
    ) {
      if (typeof payload.passwordHash !== "string") {
        throw new Error("密码哈希信息不完整");
      }
      validatePasswordHash(payload.passwordHash);
    }
    if (
      payload.kind === "ACCOUNT_ACTIVATION" ||
      payload.kind === "ACCOUNT_UPDATE"
    ) {
      if (!payload.displayName?.trim()) throw new Error("显示名称不能为空");
      if (typeof payload.role !== "string") throw new Error("账号角色不完整");
      validateRole(payload.role);
    }
  } catch (error) {
    throw new AccountCodeError(
      "INCOMPLETE",
      error instanceof Error ? error.message : "账号信息不完整",
    );
  }
  return payload as AccountCodePayload;
}

export function normalizeAccountCode(input: string) {
  const compact = input
    .replace(/[\s\u200B-\u200D\uFEFF]+/gu, "")
    .trim();
  return (
    compact.match(/VRD1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u)?.[0] ||
    compact
  );
}

export function accountCodeDigest(input: string) {
  return createHash("sha256")
    .update(normalizeAccountCode(input), "utf8")
    .digest("hex");
}

export function verifyAccountCode<T extends AccountCodePayload>(
  input: string,
  expectedKind: T["kind"],
) {
  const normalized = normalizeAccountCode(input);
  const parts = normalized.split(".");
  if (parts.length !== 3 || parts[0] !== CODE_PREFIX) {
    throw new AccountCodeError("FORMAT_INVALID", "账号激活码格式错误");
  }
  const payloadBytes = decodePart(parts[1]);
  const signature = decodePart(parts[2]);
  const signingInput = Buffer.from(`${CODE_PREFIX}.${parts[1]}`, "utf8");
  let valid = false;
  try {
    valid = verifySignature(null, signingInput, readPublicKey(), signature);
  } catch (error) {
    if (error instanceof AccountCodeError) throw error;
  }
  if (!valid) {
    throw new AccountCodeError(
      "SIGNATURE_INVALID",
      "账号激活码签名校验失败，账号激活码可能已被修改",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new AccountCodeError("FORMAT_INVALID", "账号激活码格式错误");
  }
  return {
    payload: validateCommonPayload(parsed, expectedKind) as T,
    digest: accountCodeDigest(normalized),
    signature: parts[2],
  };
}
