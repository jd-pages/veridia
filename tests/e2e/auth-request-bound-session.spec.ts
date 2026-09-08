import { expect, test, type BrowserContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { restoreDesktopSessionCookie } = require("../../desktop/session-bootstrap.cjs");

function isolatedDatabase() {
  const url = process.env.E2E_DATABASE_URL || "";
  if (!url.replaceAll("\\", "/").includes("/.playwright/e2e-runs/")) {
    throw new Error("Auth regression requires the isolated E2E runner database.");
  }
  return new PrismaClient({ datasources: { db: { url } } });
}

function desktopCookieJar(context: BrowserContext) {
  return {
    cookies: {
      get: async ({ url, name }: { url: string; name: string }) =>
        (await context.cookies(url)).filter((cookie) => cookie.name === name),
      set: async (cookie: {
        url: string; name: string; value: string;
        httpOnly: boolean; secure: boolean; sameSite: string;
      }) => context.addCookies([{
        url: cookie.url,
        name: cookie.name,
        value: cookie.value,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: "Lax",
      }]),
    },
  };
}

test("AUTH_REQUEST_BOUND_SESSION：Desktop bootstrap 恢复请求会话且匿名、失效和 VIEWER 请求不继承其他身份", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const prisma = isolatedDatabase();
  const suffix = randomUUID();
  const adminToken = process.env.VERIDIA_PERSISTENT_SESSION_TOKEN || randomBytes(32).toString("base64url");
  const viewerToken = randomBytes(32).toString("base64url");
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  const contexts: BrowserContext[] = [];
  const ids: string[] = [];
  const context = async () => {
    const result = await browser.newContext({ baseURL });
    contexts.push(result);
    return result;
  };
  try {
    for (const [role, token] of [["ADMIN", adminToken], ["VIEWER", viewerToken]]) {
      const user = await prisma.user.create({
        data: {
          username: `auth_${role}_${suffix}`,
          displayName: `Auth ${role}`,
          passwordHash: "!ISOLATED_AUTH_FIXTURE!",
          accountId: `${role}_${suffix}`,
          authProvider: "LOCAL_ACTIVATION",
          role,
          status: "ACTIVE",
        },
      });
      ids.push(user.id);
      await prisma.localAuthSession.create({
        data: {
          userId: user.id,
          tokenHash: hash(token),
          sessionVersion: user.sessionVersion,
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
    }

    const anonymous = await context();
    expect((await anonymous.request.get("/api/products")).status()).toBe(401);
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto("/dashboard");
    await expect(anonymousPage).toHaveURL(/\/login(?:\?|$)/u);
    await anonymous.addCookies([{
      url: baseURL!, name: "veridia_local_session",
      value: randomBytes(32).toString("base64url"),
    }]);
    expect((await anonymous.request.get("/api/products")).status()).toBe(401);

    const firstBoot = await context();
    expect(await restoreDesktopSessionCookie({
      session: desktopCookieJar(firstBoot), origin: baseURL, token: adminToken,
    })).toBe(true);
    expect((await firstBoot.request.get("/api/products")).status()).toBe(200);
    expect((await firstBoot.cookies()).find((cookie) => cookie.name === "veridia_local_session")).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    await firstBoot.close();

    const restarted = await context();
    expect((await restarted.request.get("/api/products")).status()).toBe(401);
    await restoreDesktopSessionCookie({ session: desktopCookieJar(restarted), origin: baseURL, token: adminToken });
    expect((await restarted.request.get("/api/auth/me")).ok()).toBeTruthy();
    expect((await (await restarted.request.get("/api/auth/me")).json()).data.role).toBe("ADMIN");
    const appPage = await restarted.newPage();
    await appPage.goto("/dashboard");
    await expect(appPage).toHaveURL(/\/dashboard$/u);

    const viewer = await context();
    await restoreDesktopSessionCookie({ session: desktopCookieJar(viewer), origin: baseURL, token: viewerToken });
    expect(await restoreDesktopSessionCookie({ session: desktopCookieJar(viewer), origin: baseURL, token: adminToken })).toBe(false);
    expect((await (await viewer.request.get("/api/auth/me")).json()).data.role).toBe("VIEWER");
    expect((await viewer.request.post("/api/products", { data: {} })).status()).toBe(403);

    await prisma.localAuthSession.update({ where: { tokenHash: hash(viewerToken) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await viewer.request.get("/api/products")).status()).toBe(401);
    await prisma.localAuthSession.update({ where: { tokenHash: hash(viewerToken) }, data: { expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date() } });
    expect((await viewer.request.get("/api/products")).status()).toBe(401);
    expect((await restarted.request.get("/api/products")).status()).toBe(200);

    await restarted.request.post("/api/auth/logout");
    expect((await restarted.request.get("/api/products")).status()).toBe(401);
    const afterLogout = await context();
    await restoreDesktopSessionCookie({ session: desktopCookieJar(afterLogout), origin: baseURL, token: adminToken });
    expect((await afterLogout.request.get("/api/products")).status()).toBe(401);
  } finally {
    await Promise.all(contexts.map((value) => value.close()));
    await prisma.localAuthSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  }
});
