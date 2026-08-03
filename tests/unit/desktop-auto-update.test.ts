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
