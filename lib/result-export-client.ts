"use client";

export interface ResultExportOutcome {
  saved: boolean;
  canceled: boolean;
  count: number;
  bytes: number;
  fileName: string;
}

export class ResultExportError extends Error {
  constructor(
    message: string,
    readonly code = "EXPORT_FAILED",
  ) {
    super(message);
    this.name = "ResultExportError";
  }
}

function responseFileName(response: Response) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // 使用后端提供的安全默认名称。
    }
  }
  return `VERIDIA审核结果_当前筛选_${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;
}

async function responseError(response: Response) {
  const text = await response.text();
  if (!text.trim()) return `导出失败（HTTP ${response.status}）`;
  try {
    const payload = JSON.parse(text) as {
      error?: string | { message?: string };
    };
    if (typeof payload.error === "string") return payload.error;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // 非 JSON 错误响应不直接暴露给正式用户。
  }
  return `导出失败（HTTP ${response.status}）`;
}

function browserSave(bytes: Uint8Array, fileName: string) {
  const browserBytes = new Uint8Array(bytes.byteLength);
  browserBytes.set(bytes);
  const blob = new Blob([browserBytes.buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export async function exportResultFile(
  query: URLSearchParams,
): Promise<ResultExportOutcome> {
  const requestQuery = new URLSearchParams(query);
  requestQuery.set("format", "xlsx");
  const response = await fetch(`/api/results/export?${requestQuery}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const message = await responseError(response);
    throw new ResultExportError(
      message,
      response.status === 404 ? "NO_EXPORT_RESULTS" : "EXPORT_REQUEST_FAILED",
    );
  }

  const count = Number(response.headers.get("x-veridia-export-count") || 0);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!Number.isInteger(count) || count < 1) {
    throw new ResultExportError(
      "当前筛选无结果，未生成文件",
      "NO_EXPORT_RESULTS",
    );
  }
  if (bytes.byteLength < 1_024) {
    throw new ResultExportError(
      "导出文件生成异常，请重试或重启 VERIDIA",
      "EMPTY_EXPORT_FILE",
    );
  }

  const fileName = responseFileName(response);
  if (window.veridiaDesktop?.saveExportFile) {
    const saved = await window.veridiaDesktop.saveExportFile({
      fileName,
      data: bytes,
    });
    if (!saved.success) {
      if (saved.canceled) {
        return {
          saved: false,
          canceled: true,
          count,
          bytes: bytes.byteLength,
          fileName,
        };
      }
      throw new ResultExportError(
        saved.error || "保存导出文件失败",
        "EXPORT_SAVE_FAILED",
      );
    }
  } else {
    browserSave(bytes, fileName);
  }

  return {
    saved: true,
    canceled: false,
    count,
    bytes: bytes.byteLength,
    fileName,
  };
}
