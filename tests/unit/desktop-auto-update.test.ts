import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("Windows desktop automatic updates", () => {
  it("installs a downloaded update silently and restarts the application", () => {
    const desktopMain = source("desktop/main.cjs");

    expect(desktopMain).toContain("autoUpdater.quitAndInstall(true, true)");
    expect(desktopMain).not.toContain("autoUpdater.quitAndInstall(false, true)");
    expect(desktopMain).not.toContain("shell.openPath(installer");
  });

  it("passes the running installation directory to the NSIS updater", () => {
    const desktopMain = source("desktop/main.cjs");

    expect(desktopMain).toContain(
      "autoUpdater.installDirectory = installDirectory()",
    );
    expect(desktopMain).toContain("path.dirname(process.execPath)");
  });

  it("uses tag-specific GitHub blockmaps and keeps differential updates enabled", () => {
    const desktopMain = source("desktop/main.cjs");
    const afterPack = source("scripts/after-pack.mjs");
    const packageJson = JSON.parse(source("package.json"));

    expect(packageJson.build.publish).toEqual([
      { provider: "github", owner: "jd-pages", repo: "veridia" },
    ]);
    expect(packageJson.build.nsis.differentialPackage).toBe(true);
    expect(desktopMain).toContain("previousBlockmapBaseUrlOverride");
    expect(desktopMain).toContain("releases/download/v${version}/");
    expect(afterPack).toContain('"provider: github"');
    expect(afterPack).not.toContain('"provider: generic"');
  });

  it("persists updater diagnostics and exposes the selected download mode", () => {
    const desktopMain = source("desktop/main.cjs");
    const updateCheck = source("desktop/update-check.cjs");

    expect(desktopMain).toContain("autoUpdater.logger =");
    expect(desktopMain).toContain("Download block maps".toLowerCase());
    expect(desktopMain).toContain("fallback to full download");
    expect(desktopMain).toContain("downloadMode: updateDownloadMode");
    expect(updateCheck).toContain("const UPDATE_CHECK_TIMEOUT_MS = 30_000");
    expect(updateCheck).toContain("updateCheckPromise = undefined");
    expect(updateCheck).toContain("manualUpdateCheck = false");
    expect(updateCheck).toContain("UPDATE_CHECK_STARTED");
    expect(updateCheck).toContain("durationMs");
  });

  it("discovers updates from GitHub Published Latest Release, never from the newest raw Tag", () => {
    const buildDesktop = source("scripts/build-desktop.mjs");
    const releaseScript = source("scripts/release.mjs");
    const desktopMain = source("desktop/main.cjs");

    expect(buildDesktop).toContain("/releases/latest/download");
    expect(releaseScript).toContain("/releases/latest/download");
    expect(desktopMain).toContain("/releases/latest");
    expect(buildDesktop).not.toContain("git tag");
    expect(releaseScript).not.toContain("git tag --sort");
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
});
