import bcrypt from "bcryptjs";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountCodeError,
  COMPACT_CODE_PREFIX,
  compactActivationSigningInput,
  normalizeAccountCode,
  verifyAccountCode,
} from "@/lib/accounts/codes";
import type {
  AccountActivationPayload,
  CompactAccountActivationPayload,
} from "@/lib/accounts/types";

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "veridia-account-code-"),
);
const publicKeyPath = path.join(fixtureRoot, "public.pem");
let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];

function signLegacyPayload(payload: AccountActivationPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = Buffer.from(`VRD1.${encoded}`, "utf8");
  const signature = sign(null, input, privateKey).toString("base64url");
  return `VRD1.${encoded}.${signature}`;
}

function signCompactPayload(payload: CompactAccountActivationPayload) {
  const { encodedPayload, signingInput } =
    compactActivationSigningInput(payload);
  const signature = sign(null, signingInput, privateKey).toString("base64url");
  return `${COMPACT_CODE_PREFIX}.${encodedPayload}.${signature}`;
}

async function validLegacyPayload(
  patch: Partial<AccountActivationPayload> = {},
): Promise<AccountActivationPayload> {
  return {
    schemaVersion: 1,
    kind: "ACCOUNT_ACTIVATION",
    authorizationVersion: 1,
    accountId: randomUUID(),
    username: "legacy_operator",
    displayName: "旧版审核员",
    role: "OPERATOR",
    passwordHash: await bcrypt.hash("Example123!", 12),
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    issuer: "VERIDIA Unit Test",
    ...patch,
  };
}

function validCompactPayload(
  patch: Partial<CompactAccountActivationPayload> = {},
): CompactAccountActivationPayload {
  return {
    v: 2,
    k: "a",
    av: 1,
    i: randomBytes(16).toString("base64url"),
    u: "compact_operator",
    n: "紧凑码审核员",
    r: "O",
    ia: Math.floor(Date.now() / 1000),
    ...patch,
  };
}

beforeAll(() => {
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  fs.writeFileSync(
    publicKeyPath,
    pair.publicKey.export({ type: "spki", format: "pem" }),
  );
  process.env.VERIDIA_ACCOUNT_SIGNING_PUBLIC_KEY_PATH = publicKeyPath;
});

afterAll(() => {
  delete process.env.VERIDIA_ACCOUNT_SIGNING_PUBLIC_KEY_PATH;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("本地账号激活码", () => {
  it("验证 VRD2 紧凑激活码且载荷不包含密码或密码哈希", () => {
    const payload = validCompactPayload();
    const code = signCompactPayload(payload);
    const verified = verifyAccountCode<AccountActivationPayload>(
      code,
      "ACCOUNT_ACTIVATION",
    );
    const decoded = JSON.parse(
      Buffer.from(code.split(".")[1]!, "base64url").toString("utf8"),
    );

    expect(code.startsWith("VRD2.")).toBe(true);
    expect(code.length).toBeLessThan(320);
    expect(verified.format).toBe("VRD2");
    expect(verified.payload.username).toBe(payload.u);
    expect(verified.payload.role).toBe("OPERATOR");
    expect(verified.payload.passwordHash).toBeUndefined();
    expect(decoded).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(decoded).toLowerCase()).not.toContain("password");
  });

  it("紧凑码长度明显短于包含 bcrypt 哈希的旧码", async () => {
    const compact = signCompactPayload(validCompactPayload());
    const legacy = signLegacyPayload(await validLegacyPayload());
    expect(compact.length).toBeLessThan(legacy.length * 0.6);
  });

  it("允许复制紧凑码时插入空格和换行", () => {
    const code = signCompactPayload(validCompactPayload());
    const wrapped = code.replace(/\./gu, ".\n  ");
    expect(normalizeAccountCode(wrapped)).toBe(code);
    expect(
      verifyAccountCode<AccountActivationPayload>(
        wrapped,
        "ACCOUNT_ACTIVATION",
      ).payload.username,
    ).toBe("compact_operator");
  });

  it.each([
    ["用户名", { u: "other_user" }],
    ["角色", { r: "A" as const }],
    ["有效期", { ea: Math.floor(Date.now() / 1000) + 86_400 }],
    ["accountId", { i: randomBytes(16).toString("base64url") }],
  ])("拒绝签名后被修改的%s", (_label, patch) => {
    const code = signCompactPayload(validCompactPayload());
    const [prefix, payloadPart, signature] = code.split(".");
    const parsed = JSON.parse(
      Buffer.from(payloadPart!, "base64url").toString("utf8"),
    );
    const modified = Buffer.from(
      JSON.stringify({ ...parsed, ...patch }),
    ).toString("base64url");
    expect(() =>
      verifyAccountCode<AccountActivationPayload>(
        `${prefix}.${modified}.${signature}`,
        "ACCOUNT_ACTIVATION",
      ),
    ).toThrow(AccountCodeError);
  });

  it("拒绝被截断的紧凑激活码", () => {
    const code = signCompactPayload(validCompactPayload());
    expect(() =>
      verifyAccountCode(code.slice(0, -12), "ACCOUNT_ACTIVATION"),
    ).toThrow();
  });

  it("拒绝紧凑载荷重新加入 passwordHash 等无效字段", () => {
    const payload = {
      ...validCompactPayload(),
      passwordHash: "$2b$12$not-allowed",
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const signature = sign(
      null,
      Buffer.from(`VRD2.${encodedPayload}`),
      privateKey,
    ).toString("base64url");
    expect(() =>
      verifyAccountCode(
        `VRD2.${encodedPayload}.${signature}`,
        "ACCOUNT_ACTIVATION",
      ),
    ).toThrow("无效字段");
  });

  it("继续兼容带 bcrypt 密码哈希的 VRD1 旧激活码", async () => {
    const code = signLegacyPayload(await validLegacyPayload());
    const verified = verifyAccountCode<AccountActivationPayload>(
      code,
      "ACCOUNT_ACTIVATION",
    );
    expect(verified.format).toBe("VRD1");
    expect(verified.payload.passwordHash).toMatch(/^\$2/u);
    expect(
      await bcrypt.compare("Example123!", verified.payload.passwordHash!),
    ).toBe(true);
  });

  it("旧格式仍拒绝低成本密码哈希", async () => {
    const payload = await validLegacyPayload({
      passwordHash: await bcrypt.hash("Example123!", 8),
    });
    expect(() =>
      verifyAccountCode(signLegacyPayload(payload), "ACCOUNT_ACTIVATION"),
    ).toThrow("安全参数不足");
  });
});
