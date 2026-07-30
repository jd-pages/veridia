import bcrypt from "bcryptjs";
import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import {
  type AccountActivationPayload,
  type AccountCodePayload,
  type AccountUpdatePayload,
  type CompactAccountActivationPayload,
  type PasswordResetPayload,
} from "../lib/accounts/types";
import {
  validatePassword,
  validateRole,
  validateUsername,
} from "../lib/accounts/validation";
import {
  COMPACT_CODE_PREFIX,
  compactActivationSigningInput,
  compactRoleCode,
  verifyAccountCode,
} from "../lib/accounts/codes";

const CODE_PREFIX = "VRD1";
const ISSUER = "VERIDIA Developer";
const PUBLIC_KEY_PATH = path.resolve(
  process.cwd(),
  "config",
  "account-signing-ed25519-public.pem",
);
const DEFAULT_PRIVATE_KEY_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "VERIDIA-Developer-Secrets",
  "account-signing-ed25519-private.pem",
);

function privateKeyPath() {
  return path.resolve(
    process.env.VERIDIA_ACCOUNT_SIGNING_KEY_PATH?.trim() ||
      DEFAULT_PRIVATE_KEY_PATH,
  );
}

function initializeKeyPair() {
  const privatePath = privateKeyPath();
  if (fs.existsSync(privatePath) || fs.existsSync(PUBLIC_KEY_PATH)) {
    throw new Error(
      "账号签名密钥已部分或全部存在。为避免覆盖现有签名体系，本工具不会自动替换。",
    );
  }
  const pair = generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(privatePath), { recursive: true });
  fs.mkdirSync(path.dirname(PUBLIC_KEY_PATH), { recursive: true });
  fs.writeFileSync(
    privatePath,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    PUBLIC_KEY_PATH,
    pair.publicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );
  console.log("账号签名密钥初始化完成。");
  console.log(`私钥安全位置：${privatePath}`);
  console.log(`客户端公钥位置：${PUBLIC_KEY_PATH}`);
  console.log("请离线备份私钥目录；本工具不会显示私钥内容。");
}

function readPrivateKey() {
  const keyPath = privateKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `未找到账号签名私钥：${keyPath}\n请先运行：npx.cmd tsx scripts/account-developer-tool.ts init-key`,
    );
  }
  if (!fs.existsSync(PUBLIC_KEY_PATH)) {
    throw new Error(`未找到客户端账号签名公钥：${PUBLIC_KEY_PATH}`);
  }
  return createPrivateKey(fs.readFileSync(keyPath));
}

function encodeAccountCode(payload: AccountCodePayload) {
  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
    "utf8",
  ).toString("base64url");
  const signingInput = Buffer.from(
    `${CODE_PREFIX}.${encodedPayload}`,
    "utf8",
  );
  const signature = sign(null, signingInput, readPrivateKey()).toString(
    "base64url",
  );
  return `${CODE_PREFIX}.${encodedPayload}.${signature}`;
}

function encodeCompactActivationCode(
  payload: CompactAccountActivationPayload,
) {
  const { encodedPayload, signingInput } =
    compactActivationSigningInput(payload);
  const signature = sign(null, signingInput, readPrivateKey()).toString(
    "base64url",
  );
  return `${COMPACT_CODE_PREFIX}.${encodedPayload}.${signature}`;
}

function copyToClipboard(value: string) {
  const command = [
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "$content = [Console]::In.ReadToEnd()",
    "Set-Clipboard -Value $content",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      input: Buffer.from(value, "utf8"),
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  return result.status === 0;
}

async function askSecret(label: string, rl: readline.Interface) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return rl.question(label);
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  return await new Promise<string>((resolve, reject) => {
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          reject(new Error("操作已取消。"));
          return;
        }
        if (character === "\b" || character === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += character;
        process.stdout.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
}

function parseExpiryDate(value: string, allowPermanent: boolean) {
  const normalized = value.trim().normalize("NFKC");
  if (
    allowPermanent &&
    (!normalized ||
      normalized.toUpperCase() === "PERMANENT" ||
      normalized === "永久")
  ) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new Error(
      allowPermanent
        ? "有效期必须输入“永久”或 YYYY-MM-DD。"
        : "有效期必须使用 YYYY-MM-DD 格式。",
    );
  }
  const date = new Date(`${normalized}T23:59:59.999+08:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error("有效期日期无效。");
  }
  if (date.getTime() <= Date.now()) {
    throw new Error("有效期必须晚于当前时间。");
  }
  return date.toISOString();
}

async function askExpiry(
  rl: readline.Interface,
  label: string,
  allowPermanent: boolean,
) {
  return parseExpiryDate(await rl.question(label), allowPermanent);
}

function displayExpiry(value: string | null) {
  if (!value) return "永久";
  return value.slice(0, 10);
}

async function createActivation(rl: readline.Interface) {
  console.log("请依次填写账号授权信息。输入内容仅在本机处理，不会上传。\n");
  const username = validateUsername(await rl.question("用户名："));
  const displayName = (await rl.question("显示名称：")).trim();
  if (!displayName) throw new Error("显示名称不能为空。");
  if ([...displayName].length > 32) {
    throw new Error("显示名称不能超过 32 个字符。");
  }
  const role = validateRole(
    (await rl.question("角色（ADMIN / OPERATOR / VIEWER）："))
      .trim()
      .toUpperCase(),
  );
  const expiresAt = await askExpiry(
    rl,
    "有效期（输入“永久”或 YYYY-MM-DD，直接回车默认为永久）：",
    true,
  );
  const payload: CompactAccountActivationPayload = {
    v: 2,
    k: "a",
    av: 1,
    i: randomBytes(16).toString("base64url"),
    u: username,
    n: displayName,
    r: compactRoleCode(role),
    ia: Math.floor(Date.now() / 1000),
    ...(expiresAt
      ? { ea: Math.floor(new Date(expiresAt).getTime() / 1000) }
      : {}),
  };
  const code = encodeCompactActivationCode(payload);
  if (!code.startsWith(`${COMPACT_CODE_PREFIX}.`)) {
    throw new Error("账号激活码生成失败。");
  }

  console.log("\n========================================");
  console.log("VERIDIA 账号创建成功");
  console.log("========================================");
  console.log(`账号：${username}`);
  console.log(`角色：${role}`);
  console.log(`有效期：${displayExpiry(expiresAt)}`);
  console.log(`激活码：${code}`);
  console.log(`激活码长度：${code.length} 个字符`);
  console.log("========================================");
  console.log("对方激活时将在自己的电脑上设置登录密码。");
  console.log(
    copyToClipboard(code)
      ? "\n激活码已复制到剪贴板，可直接粘贴到 VERIDIA 激活页面。"
      : "\n自动复制失败，请手动复制上方激活码。",
  );
}

async function createPasswordReset(rl: readline.Interface) {
  const accountId = (await rl.question("accountId：")).trim();
  if (!accountId) throw new Error("accountId 不能为空。");
  const username = validateUsername(await rl.question("用户名："));
  let password = await askSecret("新初始密码（输入时隐藏）：", rl);
  validatePassword(password);
  const expiresAt = await askExpiry(
    rl,
    "重置码有效期（YYYY-MM-DD）：",
    false,
  );
  const notes = (await rl.question("备注（可选）：")).trim();
  const payload: PasswordResetPayload = {
    schemaVersion: 1,
    kind: "PASSWORD_RESET",
    authorizationVersion: Math.floor(Date.now() / 1000),
    accountId,
    username,
    passwordHash: await bcrypt.hash(password, 12),
    issuedAt: new Date().toISOString(),
    expiresAt,
    issuer: ISSUER,
    ...(notes ? { notes } : {}),
  };
  const code = encodeAccountCode(payload);
  const result = [
    `账号：${username}`,
    `新初始密码：${password}`,
    `有效期：${displayExpiry(expiresAt)}`,
    `密码重置码：${code}`,
  ].join("\r\n");
  console.log("\n密码重置码已离线生成，信息未上传：\n");
  console.log(result);
  console.log(
    copyToClipboard(result)
      ? "\n密码重置信息已复制到剪贴板。"
      : "\n自动复制失败，请手动复制上方内容。",
  );
  password = "";
}

async function createAccountUpdate(rl: readline.Interface) {
  const accountId = (await rl.question("accountId：")).trim();
  if (!accountId) throw new Error("accountId 不能为空。");
  const username = validateUsername(await rl.question("用户名："));
  const displayName = (await rl.question("新显示名称：")).trim();
  if (!displayName) throw new Error("显示名称不能为空。");
  const role = validateRole(
    (await rl.question("新角色（ADMIN / OPERATOR / VIEWER）："))
      .trim()
      .toUpperCase(),
  );
  const expiresAt = await askExpiry(
    rl,
    "新有效期（输入“永久”或 YYYY-MM-DD，直接回车默认为永久）：",
    true,
  );
  const notes = (await rl.question("备注（可选）：")).trim();
  const payload: AccountUpdatePayload = {
    schemaVersion: 1,
    kind: "ACCOUNT_UPDATE",
    authorizationVersion: Math.floor(Date.now() / 1000),
    accountId,
    username,
    displayName,
    role,
    issuedAt: new Date().toISOString(),
    expiresAt,
    issuer: ISSUER,
    ...(notes ? { notes } : {}),
  };
  const code = encodeAccountCode(payload);
  const result = [
    `账号：${username}`,
    `显示名称：${displayName}`,
    `角色：${role}`,
    `有效期：${displayExpiry(expiresAt)}`,
    `账号更新码：${code}`,
  ].join("\r\n");
  console.log("\n账号更新码已离线生成，信息未上传：\n");
  console.log(result);
  console.log(
    copyToClipboard(result)
      ? "\n账号更新信息已复制到剪贴板。"
      : "\n自动复制失败，请手动复制上方内容。",
  );
}

async function selfTest() {
  for (const role of ["ADMIN", "OPERATOR", "VIEWER"] as const) {
    const payload: AccountActivationPayload = {
      schemaVersion: 1,
      kind: "ACCOUNT_ACTIVATION",
      authorizationVersion: 1,
      accountId: randomUUID(),
      username: `selftest_${role.toLowerCase()}`,
      displayName: "开发者工具自检",
      role,
      passwordHash: await bcrypt.hash("SelfTest123!", 12),
      issuedAt: new Date().toISOString(),
      expiresAt:
        role === "ADMIN"
          ? null
          : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      issuer: ISSUER,
    };
    const verified = verifyAccountCode<AccountActivationPayload>(
      encodeAccountCode(payload),
      "ACCOUNT_ACTIVATION",
    );
    if (verified.payload.role !== role) {
      throw new Error("开发者账号工具签名自检失败。");
    }
  }
  console.log("开发者账号工具自检通过。");
}

async function main() {
  const command = process.argv[2];
  if (command === "init-key") {
    initializeKeyPair();
    return;
  }
  if (command === "self-test") {
    await selfTest();
    return;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    if (command === "create") await createActivation(rl);
    else if (command === "reset") await createPasswordReset(rl);
    else if (command === "update") await createAccountUpdate(rl);
    else {
      throw new Error(
        "用法：account-developer-tool.ts <create|reset|update|init-key|self-test>",
      );
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "开发者账号工具运行失败。",
  );
  process.exitCode = 1;
});
