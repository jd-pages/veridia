import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("Windows desktop manual installer distribution", () => {
  it("removes every client-side software updater entry point", () => {
    const desktopMain = source("desktop/main.cjs");
    const preload = source("desktop/preload.cjs");
    const desktopTypes = source("lib/desktop-api.d.ts");
    const settings = source("app/(admin)/settings/page.tsx");
    const adminShell = source("components/AdminShell.tsx");
    const packageJson = JSON.parse(source("package.json"));
    const clientSources = [desktopMain, preload, desktopTypes, settings, adminShell];
    const removedReferences = [
      "electron-updater",
      "autoUpdater",
      "checkForUpdates",
      "openUpdateDownloadPage",
      "downloadUpdate",
      "installUpdate",
      "setAutoUpdate",
      "getUpdateStatus",
      "onUpdateStatus",
      "VERIDIA_UPDATE_URL",
      "veridia:check-update",
      "veridia:download-update",
      "veridia:install-update",
      "veridia:set-auto-update",
      "veridia:get-update-status",
      "veridia:update-status",
      "DesktopUpdateCenter",
    ];

    for (const reference of removedReferences) {
      for (const content of clientSources) expect(content).not.toContain(reference);
    }
    expect(packageJson.dependencies).not.toHaveProperty("electron-updater");
    expect(fs.existsSync(path.resolve(process.cwd(), "desktop/update-check.cjs"))).toBe(false);
    expect(fs.existsSync(path.resolve(process.cwd(), "components/DesktopUpdateCenter.tsx"))).toBe(false);
  });

  it("does not perform a software update check during startup or read legacy autoUpdate", () => {
    const desktopMain = source("desktop/main.cjs");
    const startApplication = desktopMain.slice(
      desktopMain.indexOf("async function startApplication"),
      desktopMain.indexOf("async function boot"),
    );

    expect(startApplication).not.toContain("checkForUpdates");
    expect(startApplication).not.toContain("setupUpdater");
    expect(desktopMain).not.toContain("autoUpdate");
    expect(desktopMain).not.toContain("github.com/jd-pages/veridia");
    expect(desktopMain).toContain("current.authSecret");
    expect(desktopMain).toContain("current.extensionToken");
  });

  it("retains Remote Rules update and signature verification", () => {
    const settings = source("app/(admin)/settings/page.tsx");
    const adminShell = source("components/AdminShell.tsx");
    const ruleSync = source("lib/rules/sync.ts");

    expect(settings).toContain("/api/rule-sync/check?force=true");
    expect(settings).toContain("/api/rule-sync/apply");
    expect(settings).toContain("/api/rule-sync/history");
    expect(settings).toContain("/api/rule-sync/restore");
    expect(adminShell).toContain("/api/rule-sync/check");
    expect(ruleSync).toContain("verifyRuleManifestSignature");
    expect(ruleSync).toContain("assertRulePackageCompatibleWithApp");
  });

  it("keeps a stable installer identity and the existing install mode", () => {
    const packageJson = JSON.parse(source("package.json"));

    expect(packageJson.build.appId).toBe("com.veridia.contentgovernance");
    expect(packageJson.build.nsis).toMatchObject({
      guid: "0a65335e-5c72-5806-ae48-67dc954a5513",
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      allowElevation: true,
      packElevateHelper: true,
    });
  });

  it("persists and restores InstallLocation for manual upgrades", () => {
    const installer = source("desktop/installer.nsh");

    expect(installer).toContain(
      'WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"',
    );
    expect(installer).toContain(
      'ReadRegStr $R8 HKCU "${UNINSTALL_REGISTRY_KEY}" InstallLocation',
    );
    expect(installer).toContain(
      'ReadRegStr $R9 HKLM "${UNINSTALL_REGISTRY_KEY}" InstallLocation',
    );
  });

  it("keeps local NSIS package metadata generation without a client updater", () => {
    const packageJson = JSON.parse(source("package.json"));

    expect(packageJson.build.nsis).toMatchObject({
      differentialPackage: true,
    });
    expect(packageJson.build.publish).toEqual([
      { provider: "github", owner: "jd-pages", repo: "veridia" },
    ]);
  });
});
