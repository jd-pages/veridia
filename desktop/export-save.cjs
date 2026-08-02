function createExportSaveHandler(dependencies) {
  const { app, dialog, fs, path, getWindow, writeLog } = dependencies;
  let saveInProgress = false;

  return async function saveExportFile(_event, payload) {
    if (saveInProgress) {
      return { success: false, error: "已有导出正在保存，请稍候。" };
    }
    saveInProgress = true;
    try {
      const rawName = path.basename(String(payload?.fileName || ""));
      const safeName = rawName.replace(/[\\/:*?"<>|]/gu, "_");
      if (!safeName || !/\.(xlsx|csv)$/iu.test(safeName)) {
        return { success: false, error: "保存文件名不正确。" };
      }
      const bytes = payload?.data
        ? Buffer.from(payload.data)
        : Buffer.alloc(0);
      const isImportTemplate = payload?.kind === "import-template";
      const minimumBytes = isImportTemplate ? 1 : 1_024;
      if (
        bytes.byteLength < minimumBytes ||
        bytes.byteLength > 100 * 1024 * 1024
      ) {
        return { success: false, error: "保存文件内容为空或大小异常。" };
      }
      const extension = path.extname(safeName).toLowerCase();
      const saveResult = await dialog.showSaveDialog(getWindow(), {
        title: isImportTemplate
          ? "保存 VERIDIA 导入模板"
          : "保存 VERIDIA 审核结果",
        defaultPath: path.join(app.getPath("documents"), safeName),
        buttonLabel: "保存",
        filters: [
          extension === ".csv"
            ? { name: "CSV 表格", extensions: ["csv"] }
            : { name: "Excel 工作簿", extensions: ["xlsx"] },
        ],
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { success: false, canceled: true };
      }
      await fs.promises.writeFile(saveResult.filePath, bytes);
      writeLog(
        `${isImportTemplate ? "导入模板" : "审核结果导出"}保存完成：${bytes.byteLength} 字节，保存到用户选择的位置。`,
      );
      return { success: true, filePath: saveResult.filePath };
    } catch (error) {
      writeLog("保存 VERIDIA 文件失败", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "保存文件失败。",
      };
    } finally {
      saveInProgress = false;
    }
  };
}

module.exports = { createExportSaveHandler };
