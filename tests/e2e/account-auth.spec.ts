import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID, sign } from "node:crypto";
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

function signedCompactCode(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`VRD2.${encoded}`),
    fs.readFileSync(privateKeyPath),
  ).toString("base64url");
  return `VRD2.${encoded}.${signature}`;
}

function activationCode(options?: {
  username?: string;
  role?: "ADMIN" | "OPERATOR" | "VIEWER";
  expiresAt?: string | null;
}) {
  const role = options?.role || "VIEWER";
  const payload = {
    v: 2,
    k: "a",
    av: 1,
    i: randomBytes(16).toString("base64url"),
    u: options?.username || `viewer_${Date.now()}`,
    n: "E2E只读人员",
    r: role === "ADMIN" ? "A" : role === "OPERATOR" ? "O" : "V",
    ia: Math.floor(Date.now() / 1000),
    ...(options?.expiresAt
      ? { ea: Math.floor(new Date(options.expiresAt).getTime() / 1000) }
      : {}),
  };
  return {
    accountId: payload.i,
    username: payload.u,
    password: "Viewer123!",
    code: signedCompactCode(payload),
  };
}

async function legacyActivationCode() {
  const password = "Legacy123!";
  const payload = {
    schemaVersion: 1,
    kind: "ACCOUNT_ACTIVATION",
    authorizationVersion: 1,
    accountId: randomUUID(),
    username: `legacy_${Date.now()}`,
    displayName: "旧版兼容账号",
    role: "VIEWER",
    passwordHash: await bcrypt.hash(password, 12),
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    issuer: "VERIDIA E2E",
  };
  return {
    username: payload.username,
    password,
    code: signedCode(payload),
  };
}

test("激活码签名、重复和过期校验不会产生残缺账号", async ({ page }) => {
  const before = await page.request.get("/api/auth/status");
  const beforeCount = (await before.json()).data.activatedAccountCount as number;
  const account = activationCode();

  const preview = await page.request.post("/api/auth/activate", {
    data: { activationCode: account.code, preview: true },
  });
  expect(preview.ok()).toBeTruthy();
  expect((await preview.json()).data).toMatchObject({
    username: account.username,
    requiresPassword: true,
    codeFormat: "VRD2",
  });

  const activated = await page.request.post("/api/auth/activate", {
    data: {
      activationCode: account.code,
      password: account.password,
      confirmPassword: account.password,
    },
  });
  expect(activated.ok()).toBeTruthy();
  expect((await activated.json()).data.username).toBe(account.username);

  const duplicate = await page.request.post("/api/auth/activate", {
    data: {
      activationCode: account.code,
      password: account.password,
      confirmPassword: account.password,
    },
  });
  expect(duplicate.status()).toBe(400);
  expect((await duplicate.json()).error).toContain("已经在当前电脑激活");

  const [prefix, encodedPayload, signature] = account.code.split(".");
  const tamperedPayload = JSON.parse(
    Buffer.from(encodedPayload!, "base64url").toString("utf8"),
  );
  tamperedPayload.n = "被修改的名称";
  const tampered = `${prefix}.${Buffer.from(
    JSON.stringify(tamperedPayload),
  ).toString("base64url")}.${signature}`;
  const invalid = await page.request.post("/api/auth/activate", {
    data: { activationCode: tampered },
  });
  expect(invalid.status()).toBe(400);
  expect((await invalid.json()).error).toContain("签名校验失败");

  const expired = activationCode({
    username: `expired_${Date.now()}`,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const expiredResponse = await page.request.post("/api/auth/activate", {
    data: {
      activationCode: expired.code,
      password: expired.password,
      confirmPassword: expired.password,
    },
  });
  expect(expiredResponse.status()).toBe(400);
  expect((await expiredResponse.json()).error).toContain("已经过期");

  const after = await page.request.get("/api/auth/status");
  expect((await after.json()).data.activatedAccountCount).toBe(beforeCount + 1);
});

test("紧凑激活页可现场设置密码并保持登录", async ({ page }) => {
  const account = activationCode({
    username: `compact_ui_${Date.now()}`,
    role: "OPERATOR",
  });

  await page.goto("/activate");
  await page
    .getByPlaceholder("粘贴开发者提供的账号激活码")
    .fill(account.code);
  await page.getByRole("button", { name: "验证激活码" }).click();

  await expect(page.getByText("激活码签名验证通过", { exact: true })).toBeVisible();
  await expect(page.getByText(account.username, { exact: true })).toBeVisible();
  await expect(page.getByText("OPERATOR", { exact: true })).toBeVisible();

  await page.getByPlaceholder("请输入登录密码").fill(account.password);
  await page.getByPlaceholder("请再次输入登录密码").fill(account.password);
  await page.getByRole("button", { name: "确认激活" }).click();
  await expect(page.getByText("账号激活成功", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "返回登录" }).click();
  await page.getByLabel("用户名").fill(account.username);
  await page.getByLabel("密码").fill(account.password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard$/u);

  await page.reload();
  await expect(page).toHaveURL(/\/dashboard$/u);
});

test("旧版 VRD1 激活码仍可使用原初始密码登录", async ({ page }) => {
  const account = await legacyActivationCode();
  const preview = await page.request.post("/api/auth/activate", {
    data: { activationCode: account.code, preview: true },
  });
  expect(preview.ok()).toBeTruthy();
  expect((await preview.json()).data).toMatchObject({
    username: account.username,
    requiresPassword: false,
    codeFormat: "VRD1",
  });

  const activated = await page.request.post("/api/auth/activate", {
    data: { activationCode: account.code },
  });
  expect(activated.ok()).toBeTruthy();
  const login = await page.request.post("/api/auth/login", {
    data: { username: account.username, password: account.password },
  });
  expect(login.ok()).toBeTruthy();
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
  const account = activationCode();
  expect(
    (
      await page.request.post("/api/auth/activate", {
        data: {
          activationCode: account.code,
          password: account.password,
          confirmPassword: account.password,
        },
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
  const account = activationCode({
    username: `operator_${Date.now()}`,
    role: "OPERATOR",
  });
  expect(
    (
      await page.request.post("/api/auth/activate", {
        data: {
          activationCode: account.code,
          password: account.password,
          confirmPassword: account.password,
        },
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
