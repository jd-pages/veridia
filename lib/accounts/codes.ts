import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_CODE_KINDS,
  type AccountActivationPayload,
  type AccountCodeKind,
  type AccountCodePayload,
  type CompactAccountActivationPayload,
  type CompactAccountRole,
  type LocalAccountRole,
} from "./types";
import {
  parseAccountDate,
  validatePasswordHash,
  validateRole,
  validateUsername,
} from "./validation";

const LEGACY_CODE_PREFIX = "VRD1";
export const COMPACT_CODE_PREFIX = "VRD2";
const PUBLIC_KEY_FILE = "account-signing-ed25519-public.pem";
const COMPACT_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const CODE_PART_PATTERN = /^[A-Za-z0-9_-]+$/u;
const COMPACT_KEYS = new Set(["v", "k", "av", "i", "u", "n", "r", "ia", "ea"]);

const COMPACT_TO_ROLE: Record<CompactAccountRole, LocalAccountRole> = {
  A: "ADMIN",
  O: "OPERATOR",
  V: "VIEWER",
};

const ROLE_TO_COMPACT: Record<LocalAccountRole, CompactAccountRole> = {
  ADMIN: "A",
  OPERATOR: "O",
  VIEWER: "V",
};

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
      "当前软件无法验证该账号激活码。",
    );
  }
  return createPublicKey(fs.readFileSync(keyPath, "utf8"));
}

function decodePart(value: string) {
  if (!value || !CODE_PART_PATTERN.test(value)) {
    throw new AccountCodeError("FORMAT_INVALID", "账号激活码格式错误。");
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new AccountCodeError("FORMAT_INVALID", "账号激活码格式错误。");
  }
}

function verifySignedParts(
  prefix: string,
  payloadPart: string,
  signaturePart: string,
) {
  const signature = decodePart(signaturePart);
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(`${prefix}.${payloadPart}`, "utf8"),
      readPublicKey(),
      signature,
    );
  } catch (error) {
    if (error instanceof AccountCodeError) throw error;
  }
  if (!valid) {
    throw new AccountCodeError(
      "SIGNATURE_INVALID",
      "账号激活码签名校验失败，激活码可能已被修改。",
    );
  }
}

function parseJsonPayload(payloadPart: string) {
  try {
    return JSON.parse(decodePart(payloadPart).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof AccountCodeError) throw error;
    throw new AccountCodeError("FORMAT_INVALID", "账号激活码格式错误。");
  }
}

function validateLegacyPayload(
  value: unknown,
  expectedKind: AccountCodeKind,
): AccountCodePayload {
  if (!value || typeof value !== "object") {
    throw new AccountCodeError("INCOMPLETE", "账号授权信息不完整。");
  }
  const payload = value as Partial<AccountCodePayload>;
  if (payload.schemaVersion !== 1) {
    throw new AccountCodeError(
      "SCHEMA_INCOMPATIBLE",
      "账号授权版本与当前软件不兼容。",
    );
  }
  if (
    payload.kind !== expectedKind ||
    !ACCOUNT_CODE_KINDS.includes(payload.kind as AccountCodeKind)
  ) {
    throw new AccountCodeError("KIND_INVALID", "账号激活码类型无效。");
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
    throw new AccountCodeError("INCOMPLETE", "账号授权信息不完整。");
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
        throw new Error("密码哈希信息不完整。");
      }
      validatePasswordHash(payload.passwordHash);
    }
    if (
      payload.kind === "ACCOUNT_ACTIVATION" ||
      payload.kind === "ACCOUNT_UPDATE"
    ) {
      if (!payload.displayName?.trim()) {
        throw new Error("显示名称不能为空。");
      }
      if (typeof payload.role !== "string") {
        throw new Error("账号角色信息不完整。");
      }
      validateRole(payload.role);
    }
  } catch (error) {
    throw new AccountCodeError(
      "INCOMPLETE",
      error instanceof Error ? error.message : "账号授权信息不完整。",
    );
  }
  return payload as AccountCodePayload;
}

function compactTimestampToIso(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AccountCodeError("INCOMPLETE", `${field}无效。`);
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new AccountCodeError("INCOMPLETE", `${field}无效。`);
  }
  return date.toISOString();
}

function validateCompactActivationPayload(
  value: unknown,
  expectedKind: AccountCodeKind,
): AccountActivationPayload {
  if (expectedKind !== "ACCOUNT_ACTIVATION") {
    throw new AccountCodeError("KIND_INVALID", "账号激活码类型无效。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AccountCodeError("INCOMPLETE", "账号授权信息不完整。");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !COMPACT_KEYS.has(key))) {
    throw new AccountCodeError("INCOMPLETE", "紧凑账号授权包含无效字段。");
  }
  const payload = record as unknown as Partial<CompactAccountActivationPayload>;
  if (payload.v !== 2 || payload.k !== "a") {
    throw new AccountCodeError(
      "SCHEMA_INCOMPATIBLE",
      "账号授权版本与当前软件不兼容。",
    );
  }
  if (
    !Number.isSafeInteger(payload.av) ||
    Number(payload.av) < 1 ||
    Number(payload.av) > 2_147_483_647 ||
    typeof payload.i !== "string" ||
    !COMPACT_ACCOUNT_ID_PATTERN.test(payload.i) ||
    typeof payload.u !== "string" ||
    typeof payload.n !== "string" ||
    !payload.n.trim() ||
    [...payload.n.trim()].length > 32 ||
    typeof payload.r !== "string" ||
    !Object.hasOwn(COMPACT_TO_ROLE, payload.r)
  ) {
    throw new AccountCodeError("INCOMPLETE", "账号授权信息不完整。");
  }
  validateUsername(payload.u);
  const issuedAt = compactTimestampToIso(Number(payload.ia), "签发时间");
  const expiresAt =
    payload.ea === undefined
      ? null
      : compactTimestampToIso(Number(payload.ea), "到期时间");
  return {
    schemaVersion: 2,
    kind: "ACCOUNT_ACTIVATION",
    authorizationVersion: Number(payload.av),
    accountId: payload.i,
    username: payload.u,
    displayName: payload.n.trim(),
    role: COMPACT_TO_ROLE[payload.r as CompactAccountRole],
    issuedAt,
    expiresAt,
    issuer: "vd",
  };
}

export function compactRoleCode(role: LocalAccountRole) {
  return ROLE_TO_COMPACT[role];
}

export function compactActivationSigningInput(
  payload: CompactAccountActivationPayload,
) {
  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
    "utf8",
  ).toString("base64url");
  return {
    encodedPayload,
    signingInput: Buffer.from(
      `${COMPACT_CODE_PREFIX}.${encodedPayload}`,
      "utf8",
    ),
  };
}

export function normalizeAccountCode(input: string) {
  const compact = input
    .replace(/[\s\u200B-\u200D\uFEFF]+/gu, "")
    .trim();
  return (
    compact.match(/VRD[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u)?.[0] ||
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
  const prefix = parts[0];
  if (
    parts.length !== 3 ||
    (prefix !== LEGACY_CODE_PREFIX && prefix !== COMPACT_CODE_PREFIX)
  ) {
    throw new AccountCodeError("FORMAT_INVALID", "账号激活码格式错误。");
  }
  const payloadPart = parts[1]!;
  const signaturePart = parts[2]!;
  verifySignedParts(prefix, payloadPart, signaturePart);
  const parsed = parseJsonPayload(payloadPart);
  const payload =
    prefix === COMPACT_CODE_PREFIX
      ? validateCompactActivationPayload(parsed, expectedKind)
      : validateLegacyPayload(parsed, expectedKind);
  return {
    payload: payload as T,
    digest: accountCodeDigest(normalized),
    signature: signaturePart,
    format: prefix as typeof LEGACY_CODE_PREFIX | typeof COMPACT_CODE_PREFIX,
  };
}
