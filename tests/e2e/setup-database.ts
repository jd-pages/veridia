import { execFileSync } from "node:child_process";
import {
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";

const defaultDatabasePath = path.resolve(process.cwd(), "prisma", "e2e.db");
const defaultDatabaseUrl = `file:${defaultDatabasePath}`;
const databaseUrl =
  process.env.E2E_DATABASE_URL?.trim() || defaultDatabaseUrl;
const accountKeyRoot = path.join(
  os.tmpdir(),
  "veridia-e2e-account-signing",
);
const accountPublicKeyPath = path.join(accountKeyRoot, "public.pem");
const accountPrivateKeyPath = path.join(accountKeyRoot, "private.pem");
const defaultE2eProfilePath = path.resolve(
  process.cwd(),
  ".playwright",
  "xhs-e2e-profile",
);
const e2eProfilePath = path.resolve(
  process.env.E2E_XHS_PROFILE_PATH?.trim() || defaultE2eProfilePath,
);

async function prepareEphemeralAccountKey() {
  const pair = generateKeyPairSync("ed25519");
  await mkdir(accountKeyRoot, { recursive: true });
  await writeFile(
    accountPrivateKeyPath,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  await writeFile(
    accountPublicKeyPath,
    pair.publicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );
  process.env.VERIDIA_ACCOUNT_SIGNING_PUBLIC_KEY_PATH =
    accountPublicKeyPath;
  return pair.privateKey;
}

function signActivationCode(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  return bcrypt.hash("Admin123!", 12).then((passwordHash) => {
    const payload = {
      schemaVersion: 1,
      kind: "ACCOUNT_ACTIVATION",
      authorizationVersion: 1,
      accountId: randomUUID(),
      username: "admin",
      displayName: "验收管理员",
      role: "ADMIN",
      passwordHash,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      issuer: "VERIDIA E2E",
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );
    const input = Buffer.from(`VRD1.${encodedPayload}`, "utf8");
    const signature = sign(null, input, privateKey).toString("base64url");
    return `VRD1.${encodedPayload}.${signature}`;
  });
}

async function resetDefaultDatabase() {
  if (databaseUrl !== defaultDatabaseUrl) return;
  const outputDirectory = path.resolve(process.cwd(), "prisma");
  const databasePath = defaultDatabasePath;
  const relative = path.relative(outputDirectory, databasePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("E2E 数据库路径不在 prisma 目录内");
  }
  await mkdir(outputDirectory, { recursive: true });
  await rm(databasePath, { force: true });
}

async function resetE2eBrowserProfile() {
  const playwrightRoot = path.resolve(process.cwd(), ".playwright");
  const relative = path.relative(playwrightRoot, e2eProfilePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("E2E 小红书 Profile 必须位于项目 .playwright 目录内");
  }
  await rm(e2eProfilePath, { recursive: true, force: true });
}

async function main() {
  await resetDefaultDatabase();
  await resetE2eBrowserProfile();
  const accountPrivateKey = await prepareEphemeralAccountKey();
  process.env.DATABASE_URL = databaseUrl;

  const commandEnvironment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
  };
  execFileSync(
    process.execPath,
    [path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "scripts/ensure-sqlite-db.ts"],
    {
      cwd: process.cwd(),
      env: commandEnvironment,
      stdio: "inherit",
    },
  );
  execFileSync(
    process.execPath,
    [
      path.resolve(process.cwd(), "node_modules/prisma/build/index.js"),
      "migrate",
      "deploy",
    ],
    {
    cwd: process.cwd(),
    env: commandEnvironment,
    stdio: "inherit",
    },
  );

  const [
    { prisma },
    { ensureLocalRuntime },
    { ensureBuiltinRules },
    { activateLocalAccount },
  ] =
    await Promise.all([
      import("../../lib/db"),
      import("../../lib/local-runtime"),
      import("../../lib/rules/sync"),
      import("../../lib/accounts/service"),
    ]);
  const [{ createMockNote }, { normalizeUrl }, { runAuditTask }] =
    await Promise.all([
      import("../../lib/mock-data"),
      import("../../lib/topic"),
      import("../../lib/audit-service"),
    ]);

  await ensureLocalRuntime();
  if (
    (await prisma.user.count({
      where: {
        authProvider: "LOCAL_ACTIVATION",
        accountId: { not: null },
      },
    })) === 0
  ) {
    await activateLocalAccount(await signActivationCode(accountPrivateKey));
  }
  await ensureBuiltinRules();
  if ((await prisma.auditResult.count()) === 0) {
    const product = await prisma.product.findFirstOrThrow({
      where: { deletedAt: null },
    });
    const campaign = await prisma.campaign.findFirstOrThrow({
      where: { deletedAt: null },
    });
    for (let index = 0; index < 15; index += 1) {
      const payload = createMockNote("passed");
      payload.url = `${payload.url}&isolated-fixture=${index + 1}`;
      payload.finalUrl = index === 0
        ? `${payload.url}&resolved=final`
        : payload.url;
      payload.noteId = `isolated-fixture-${index + 1}`;
      payload.pageEvidence = {
        originalUrl: payload.url,
        finalUrl: payload.finalUrl,
        pageTitle: payload.title,
        pageType: "NOTE_DETAIL",
        visibleTextPreview: `${payload.title}\n${payload.body}`,
        visibleTextLength: `${payload.title}\n${payload.body}`.length,
        htmlLength: 4096,
        noteIdCandidates: [
          {
            value: payload.noteId,
            source: "final-url",
          },
        ],
        bodyCandidates: [
          {
            value: payload.body,
            source: "dom-visible-text",
          },
        ],
        topicCandidates: payload.topics.map((topic) => ({
          displayText: topic.displayText,
          source: "dom-topic-link",
          href: topic.href,
          hasHref: topic.hasHref,
          isLinkElement: topic.isLinkElement,
        })),
        imageCandidates: Array.from(
          { length: payload.imageCount || 0 },
          (_, imageIndex) => ({
            groupKey: `mock-carousel-image-${imageIndex + 1}`,
            source: "carousel-img",
          }),
        ),
      };
      const task = await prisma.auditTask.create({
        data: {
          url: payload.url,
          normalizedUrl: normalizeUrl(payload.url),
          productId: product.id,
          campaignId: campaign.id,
          productStage: "IFFO_2",
          source: "SEED",
          notes: "Playwright isolated fixture",
          platform: "XIAOHONGSHU",
          channel: "XIAOHONGSHU",
          commercePlatform: "JD",
          storeName: "京东健康进口超市 Playwright 测试长店铺名称",
          orderNumber: `ORDER-${payload.noteId}`,
        },
      });
      await runAuditTask(task.id, payload);
    }
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "E2E 数据库初始化失败");
  process.exit(1);
});
