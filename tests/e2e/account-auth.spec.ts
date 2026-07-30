import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";
import { randomUUID, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const privateKeyPath = path.join(
  os.tmpdir(),
  "veridia-e2e-account-signing",
  "private.pem",
);

function signedCode(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`VRD1.${encoded}`),
    fs.readFileSync(privateKeyPath),
  ).toString("base64url");
  return `VRD1.${encoded}.${signature}`;
}

async function activationCode(options?: {
  username?: string;
  role?: "ADMIN" | "OPERATOR" | "VIEWER";
  expiresAt?: string | null;
}) {
  const payload = {
    schemaVersion: 1,
    kind: "ACCOUNT_ACTIVATION",
    authorizationVersion: 1,
    accountId: randomUUID(),
    username: options?.username || `viewer_${Date.now()}`,
    displayName: "E2E只读人员",
    role: options?.role || "VIEWER",
    passwordHash: await bcrypt.hash("Viewer123!", 12),
    issuedAt: new Date().toISOString(),
    expiresAt: options?.expiresAt ?? null,
    issuer: "VERIDIA E2E",
  };
  return {
    accountId: payload.accountId,
    username: payload.username,
    code: signedCode(payload),
  };
}

test("激活码签名、重复和过期校验不会产生残缺账号", async ({ page }) => {
  const before = await page.request.get("/api/auth/status");
  const beforeCount = (await before.json()).data.activatedAccountCount as number;
  const account = await activationCode();

  const activated = await page.request.post("/api/auth/activate", {
    data: { activationCode: account.code },
  });
  expect(activated.ok()).toBeTruthy();
  expect((await activated.json()).data.username).toBe(account.username);

  const duplicate = await page.request.post("/api/auth/activate", {
    data: { activationCode: account.code },
  });
  expect(duplicate.status()).toBe(400);
  expect((await duplicate.json()).error).toContain("已经在当前电脑激活");

  const [prefix, encodedPayload, signature] = account.code.split(".");
  const tamperedPayload = JSON.parse(
    Buffer.from(encodedPayload!, "base64url").toString("utf8"),
  );
  tamperedPayload.displayName = "被修改的名称";
  const tampered = `${prefix}.${Buffer.from(
    JSON.stringify(tamperedPayload),
  ).toString("base64url")}.${signature}`;
  const invalid = await page.request.post("/api/auth/activate", {
    data: { activationCode: tampered },
  });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).error).toContain("签名校验失败");

  const expired = await activationCode({
    username: `expired_${Date.now()}`,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const expiredResponse = await page.request.post("/api/auth/activate", {
    data: { activationCode: expired.code },
  });
  expect(expiredResponse.status()).toBe(400);
  expect((await expiredResponse.json()).error).toContain("已经过期");

  const after = await page.request.get("/api/auth/status");
  expect((await after.json()).data.activatedAccountCount).toBe(beforeCount + 1);
});

test("登录错误提示一致、本地限流且正确密码可以登录", async ({ page }) => {
  const unknownUsername = `missing_${Date.now()}`;
  const unknown = await page.request.post("/api/auth/login", {
    data: { username: unknownUsername, password: "Wrong123!" },
  });
  expect(unknown.status()).toBe(401);
  expect((await unknown.json()).error).toBe("用户名或密码错误。");

  const wrong = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Wrong123!" },
  });
  expect(wrong.status()).toBe(401);
  expect((await wrong.json()).error).toBe("用户名或密码错误。");

  for (let index = 1; index < 5; index += 1) {
    await page.request.post("/api/auth/login", {
      data: { username: unknownUsername, password: "Wrong123!" },
    });
  }
  const throttled = await page.request.post("/api/auth/login", {
    data: { username: unknownUsername, password: "Wrong123!" },
  });
  expect(throttled.status()).toBe(429);
  expect((await throttled.json()).error).toContain("稍后再试");

  const login = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "Admin123!" },
  });
  expect(login.ok()).toBeTruthy();
  const data = (await login.json()).data;
  expect(data.user.role).toBe("ADMIN");
  expect(data.persistentToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  expect(JSON.stringify(data)).not.toContain("$2");
});

test("VIEWER 后端不能创建任务或修改产品", async ({ page }) => {
  const account = await activationCode();
  expect(
    (
      await page.request.post("/api/auth/activate", {
        data: { activationCode: account.code },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { username: account.username, password: "Viewer123!" },
      })
    ).ok(),
  ).toBeTruthy();

  const createTask = await page.request.post("/api/tasks", {
    data: { productId: "x", campaignId: "x", urls: ["https://example.com"] },
  });
  expect(createTask.status()).toBe(403);
  const createProduct = await page.request.post("/api/products", {
    data: { name: "越权产品" },
  });
  expect(createProduct.status()).toBe(403);
});

test("改密、开发者重置码和账号更新码会使旧会话失效", async ({ page }) => {
  const account = await activationCode({
    username: `operator_${Date.now()}`,
    role: "OPERATOR",
  });
  expect(
    (
      await page.request.post("/api/auth/activate", {
        data: { activationCode: account.code },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { username: account.username, password: "Viewer123!" },
      })
    ).ok(),
  ).toBeTruthy();

  const changed = await page.request.post("/api/auth/change-password", {
    data: {
      currentPassword: "Viewer123!",
      newPassword: "Changed123!",
      confirmPassword: "Changed123!",
    },
  });
  expect(changed.ok()).toBeTruthy();
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { username: account.username, password: "Viewer123!" },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { username: account.username, password: "Changed123!" },
      })
    ).ok(),
  ).toBeTruthy();

  const resetPassword = "Reset123!";
  const resetCode = signedCode({
    schemaVersion: 1,
    kind: "PASSWORD_RESET",
    authorizationVersion: Math.floor(Date.now() / 1000),
    accountId: account.accountId,
    username: account.username,
    passwordHash: await bcrypt.hash(resetPassword, 12),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    issuer: "VERIDIA E2E",
  });
  expect(
    (
      await page.request.post("/api/auth/reset-code", {
        data: { resetCode },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.post("/api/auth/login", {
        data: { username: account.username, password: "Changed123!" },
      })
    ).status(),
  ).toBe(401);

  const updatedCode = signedCode({
    schemaVersion: 1,
    kind: "ACCOUNT_UPDATE",
    authorizationVersion: Math.floor(Date.now() / 1000) + 1,
    accountId: account.accountId,
    username: account.username,
    displayName: "续期只读人员",
    role: "VIEWER",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    issuer: "VERIDIA E2E",
  });
  const updated = await page.request.post("/api/auth/update-code", {
    data: { updateCode: updatedCode },
  });
  const updatedBody = await updated.json();
  expect(updated.ok(), JSON.stringify(updatedBody)).toBeTruthy();
  expect(updatedBody.data.role).toBe("VIEWER");

  const login = await page.request.post("/api/auth/login", {
    data: { username: account.username, password: resetPassword },
  });
  expect(login.ok()).toBeTruthy();
  expect((await login.json()).data.user.role).toBe("VIEWER");
});
