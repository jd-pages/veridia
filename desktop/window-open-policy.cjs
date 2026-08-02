function installWindowOpenPolicy(dependencies) {
  const { window, shell, internalOrigin, writeLog } = dependencies;
  const origin = new URL(internalOrigin).origin;

  window.setMenuBarVisibility(false);
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.origin === origin) {
        if (
          [
            "/api/import/template",
            "/api/results/export",
            "/api/tasks/export",
            "/api/rule-import/template",
            "/api/products/excel",
          ].includes(target.pathname)
        ) {
          window.webContents.downloadURL(target.toString());
        }
        return { action: "deny" };
      }
      if (target.protocol === "http:" || target.protocol === "https:") {
        void Promise.resolve(shell.openExternal(target.toString())).catch(
          (error) => writeLog("打开外部链接失败", error),
        );
      }
    } catch (error) {
      writeLog("已阻止无效的新窗口请求", error);
    }
    return { action: "deny" };
  });
}

module.exports = { installWindowOpenPolicy };
