import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
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
  // This scenario cold-loads several protected pages and API routes in the
  // Next.js dev server. Windows CI can legitimately exceed the global 45s
  // timeout while compiling those routes, even though each assertion passes.
  test.setTimeout(180_000);

  const account = activationCode({
    username: `compact_ui_${Date.now()}`,
    role: "OPERATOR",
  });

  await page.goto("/activate");
  await page
    .getByPlaceholder("粘贴账号管理员提供的激活码")
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
  await expect(page).toHaveURL(/\/dashboard$/u, { timeout: 30_000 });

  await page.reload();
  await expect(page).toHaveURL(/\/dashboard$/u);

  for (const label of [
    "仪表盘",
    "审核任务",
    "审核结果",
    "产品管理",
    "活动管理",
    "话题规则",
    "导入记录",
    "系统设置",
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  for (const endpoint of [
    "/api/dashboard",
    "/api/tasks",
    "/api/results?pageSize=1",
    "/api/products",
    "/api/campaigns",
    "/api/rules",
    "/api/rule-stage-groups",
    "/api/automation/batches",
    "/api/automation/session",
    "/api/browser/status",
    "/api/imports",
  ]) {
    const response = await page.request.get(endpoint);
    expect(response.status(), endpoint).toBe(200);
    expect(response.headers()["content-type"], endpoint).toContain(
      "application/json",
    );
    expect((await response.json()).success, endpoint).toBe(true);
  }

  const resultList = await page.request.get("/api/results?page=1&pageSize=1");
  expect(resultList.ok()).toBeTruthy();
  const firstResult = (await resultList.json()).data.items[0] as {
    id: string;
    task: { product: { id: string } };
  };
  for (const query of [
    "",
    `ids=${encodeURIComponent(firstResult.id)}`,
    `productId=${encodeURIComponent(firstResult.task.product.id)}`,
  ]) {
    const exported = await page.request.get(`/api/results/export?${query}`);
    expect(exported.status(), query || "current results").toBe(200);
    expect(exported.headers()["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await exported.body()) as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0],
    );
    const headers = workbook.worksheets[0]?.getRow(1).values as unknown[];
    expect([
      [
        "平台",
        "店铺名称",
        "客户名",
        "产品系列",
        "阶段",
        "段位",
        "订单编号",
        "内容渠道",
        "链接",
        "发布时间",
        "活动名称",
        "自审",
      ],
      [
        "登记时间",
        "渠道",
        "店铺名称",
        "客户备注",
        "买家购买ID",
        "购买订单号",
        "购买时间",
        "购买罐数",
        "参与次数",
        "发布小红书账号",
        "小红书发布链接",
        "购买产品线",
        "活动名称",
        "自审",
      ],
    ]).toContainEqual(headers.slice(1));
  }

  const operatorProduct = await page.request.post("/api/products", {
    data: {
      name: `审核员权限测试产品-${Date.now()}`,
      brandName: "VERIDIA E2E",
    },
  });
  expect(operatorProduct.status()).toBe(201);
  const operatorProductId = (await operatorProduct.json()).data.id as string;
  expect(
    (await page.request.delete(`/api/products/${operatorProductId}`)).ok(),
  ).toBeTruthy();

  await page.goto("/tasks");
  await expect(page.getByText("审核任务", { exact: true }).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    "Unexpected end of JSON input",
  );
  const taskLinkInput = page.getByPlaceholder(
    /xiaohongshu\.com\/explore\/xxxx/u,
  );
  await expect(taskLinkInput).toBeVisible();
  await expect(taskLinkInput).toHaveValue("");
  expect(await taskLinkInput.getAttribute("placeholder")).not.toContain(
    "localhost:3100/mock",
  );

  await page.goto("/results");
  const batchDelete = page
    .getByRole("region", { name: "批量操作" })
    .getByRole("button", { name: /批量删除/u });
  await expect(batchDelete).toBeVisible();
  await expect(batchDelete).toBeDisabled();
  const firstResultRow = page.locator(".ant-table-row").first();
  await expect(firstResultRow).toBeVisible();
  const selectionControl = firstResultRow.locator(
    "td.ant-table-selection-column label.ant-checkbox-wrapper",
  );
  await selectionControl.click();
  const selectedBatchDelete = page.getByRole("button", {
    name: /批量删除（1）/u,
  });
  await expect(selectedBatchDelete).toBeEnabled();
  await selectedBatchDelete.click();
  const deleteDialog = page.getByRole("dialog");
  await expect(
    deleteDialog.getByText(
      "确认删除已选择的 1 条审核结果？删除后不可恢复。",
      { exact: true },
    ),
  ).toBeVisible();
  await deleteDialog.getByRole("button", { name: /取\s*消/u }).click();
  await expect(deleteDialog).toBeHidden();

  const operatorBatchDelete = await page.request.post(
    "/api/results/batch-delete",
    { data: { ids: [`missing-${Date.now()}`] } },
  );
  expect(operatorBatchDelete.status()).toBe(200);
  const operatorSingleDelete = await page.request.delete(
    `/api/results/missing-${Date.now()}`,
  );
  expect(operatorSingleDelete.status()).toBe(200);

  await page.goto("/products");
  await expect(page.getByRole("heading", { name: "产品管理" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新增产品" })).toBeVisible();
  await page.goto("/campaigns");
  await expect(page.getByRole("button", { name: "导入活动规则" })).toBeVisible();
  await page.goto("/rules");
  const e2eBrandCard = page.locator(".ant-card").filter({
    has: page.getByText("VERIDIA E2E", { exact: true }),
  });
  await expect(e2eBrandCard).toHaveCount(1);
  await e2eBrandCard.getByRole("button", { name: "进入规则" }).click();
  await expect(
    page.getByRole("button", { name: "新增月份规则" }),
  ).toBeVisible();

  for (const endpoint of [
    "/api/settings",
    "/api/users",
    "/api/rule-sync/status",
  ]) {
    expect((await page.request.get(endpoint)).status(), endpoint).toBe(200);
  }
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/u);
  await expect(page.getByText("账号安全", { exact: true })).toBeVisible();
  await expect(page.getByText("本机账号管理", { exact: true })).toBeVisible();
  await expect(page.getByText("小红书会话诊断", { exact: true })).toBeVisible();
  await expect(page.getByText("小红书访问节奏", { exact: true })).toBeVisible();
  await expect(page.getByText("规则同步", { exact: true })).toBeVisible();
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
