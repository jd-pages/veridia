import bcrypt from "bcryptjs";
import {
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccountCodeError,
  normalizeAccountCode,
  verifyAccountCode,
} from "@/lib/accounts/codes";
import type { AccountActivationPayload } from "@/lib/accounts/types";

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "veridia-account-code-"),
);
const publicKeyPath = path.join(fixtureRoot, "public.pem");
let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];

function signPayload(payload: AccountActivationPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = Buffer.from(`VRD1.${encoded}`, "utf8");
  const signature = sign(null, input, privateKey).toString("base64url");
  return `VRD1.${encoded}.${signature}`;
}

async function validPayload(
  patch: Partial<AccountActivationPayload> = {},
): Promise<AccountActivationPayload> {
  return {
    schemaVersion: 1,
    kind: "ACCOUNT_ACTIVATION",
    authorizationVersion: 1,
    accountId: randomUUID(),
    username: "operator_01",
    displayName: "测试审核员",
    role: "OPERATOR",
    passwordHash: await bcrypt.hash("Example123!", 12),
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    issuer: "VERIDIA Unit Test",
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
  it("使用 Ed25519 验证有效账号且不包含明文密码", async () => {
    const payload = await validPayload();
    const code = signPayload(payload);
    expect(code).not.toContain("Example123!");
    const verified = verifyAccountCode<AccountActivationPayload>(
      code,
      "ACCOUNT_ACTIVATION",
    );
    expect(verified.payload.accountId).toBe(payload.accountId);
    expect(verified.payload.role).toBe("OPERATOR");
    expect(await bcrypt.compare("Example123!", verified.payload.passwordHash)).toBe(
      true,
    );
  });

  it("允许复制时插入空格和换行", async () => {
    const code = signPayload(await validPayload());
    const wrapped = code.replace(/\./gu, ".\n  ");
    expect(normalizeAccountCode(wrapped)).toBe(code);
    expect(
      verifyAccountCode<AccountActivationPayload>(
        wrapped,
        "ACCOUNT_ACTIVATION",
      ).payload.username,
    ).toBe("operator_01");
  });

  it.each([
    ["用户名", { username: "other_user" }],
    ["角色", { role: "ADMIN" as const }],
    ["有效期", { expiresAt: "2030-01-01T00:00:00.000Z" }],
    ["accountId", { accountId: randomUUID() }],
  ])("拒绝签名后被修改的%s", async (_label, patch) => {
    const original = await validPayload();
    const code = signPayload(original);
    const [, payloadPart, signature] = code.split(".");
    const parsed = JSON.parse(
      Buffer.from(payloadPart!, "base64url").toString("utf8"),
    );
    const modified = Buffer.from(
      JSON.stringify({ ...parsed, ...patch }),
    ).toString("base64url");
    expect(() =>
      verifyAccountCode<AccountActivationPayload>(
        `VRD1.${modified}.${signature}`,
        "ACCOUNT_ACTIVATION",
      ),
    ).toThrow(AccountCodeError);
  });

  it("拒绝密码哈希被修改和被截断的激活码", async () => {
    const code = signPayload(await validPayload());
    const parts = code.split(".");
    const parsed = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    );
    parsed.passwordHash = `${parsed.passwordHash}x`;
    const modified = Buffer.from(JSON.stringify(parsed)).toString("base64url");
    expect(() =>
      verifyAccountCode(
        `VRD1.${modified}.${parts[2]}`,
        "ACCOUNT_ACTIVATION",
      ),
    ).toThrow("签名校验失败");
    expect(() =>
      verifyAccountCode(code.slice(0, -12), "ACCOUNT_ACTIVATION"),
    ).toThrow();
  });

  it("拒绝低成本或明文密码字段", async () => {
    const payload = await validPayload({
      passwordHash: await bcrypt.hash("Example123!", 8),
    });
    expect(() =>
      verifyAccountCode(signPayload(payload), "ACCOUNT_ACTIVATION"),
    ).toThrow("安全参数不足");
  });
});
