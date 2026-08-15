"use client";

export type ImportTemplateFormat = "xlsx";
export type ImportTemplateBrand = "danone-customer" | "kabrita";

export interface ImportTemplateDownloadOutcome {
  saved: boolean;
  canceled: boolean;
  fileName: string;
  bytes: number;
}

function responseFileName(response: Response, format: ImportTemplateFormat) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // 使用下面不含用户输入的安全文件名。
    }
  }
  return `VERIDIA导入模板_${new Date().toISOString().slice(0, 10)}.${format}`;
}

function browserSave(bytes: Uint8Array, fileName: string, contentType: string) {
  const browserBytes = new Uint8Array(bytes.byteLength);
  browserBytes.set(bytes);
  const objectUrl = URL.createObjectURL(
    new Blob([browserBytes.buffer], { type: contentType }),
  );
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export async function downloadImportTemplate(
  format: ImportTemplateFormat,
  brand: ImportTemplateBrand = "danone-customer",
): Promise<ImportTemplateDownloadOutcome> {
  const response = await fetch(
    `/api/import/template?format=${format}&brand=${brand}`,
    {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    },
  );
  if (!response.ok) {
    throw new Error(`下载导入模板失败（HTTP ${response.status}）`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error("下载的导入模板内容为空");
  }
  const fileName = responseFileName(response, format);

  if (window.veridiaDesktop?.saveExportFile) {
    const saved = await window.veridiaDesktop.saveExportFile({
      fileName,
      data: bytes,
      kind: "import-template",
    });
    if (!saved.success) {
      if (saved.canceled) {
        return {
          saved: false,
          canceled: true,
          fileName,
          bytes: bytes.byteLength,
        };
      }
      throw new Error(saved.error || "保存导入模板失败");
    }
  } else {
    browserSave(
      bytes,
      fileName,
      response.headers.get("content-type") || "application/octet-stream",
    );
  }

  return {
    saved: true,
    canceled: false,
    fileName,
    bytes: bytes.byteLength,
  };
}
