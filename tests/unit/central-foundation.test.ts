import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AUTH_MODES,
  CENTRAL_FOUNDATION_EFFECTIVE_AUTH_MODE,
  normalizeAuthMode,
  type LocalUsageSyncDraft,
} from "@/lib/central/contracts";
import { createRandomDeviceId } from "@/lib/central/device-id";
import {
  CENTRAL_SYNC_DENIED_DATA,
  CENTRAL_SYNC_FIELD_ALLOWLIST,
  findDeniedSyncFields,
  pickUsageSyncDraft,
} from "@/lib/central/privacy";

const usage: LocalUsageSyncDraft = {
  date: "2026-07-29",
  localUserId: "local-user-1",
  deviceId: "7c1264dd-df53-4f77-bce0-1e3312f0c565",
  softwareVersion: "1.0.2",
  ruleVersion: "8",
  taskCount: 10,
  auditCount: 9,
  passedCount: 5,
  failedCount: 3,
  reviewCount: 1,
  nonSensitiveErrorCount: 2,
};

describe("中央兼容基础", () => {
  it("声明三种认证模式，但第一阶段有效模式固定为 LOCAL", () => {
    expect(AUTH_MODES).toEqual(["LOCAL", "DUAL", "CENTRAL"]);
    expect(normalizeAuthMode("DUAL")).toBe("DUAL");
    expect(normalizeAuthMode("CENTRAL")).toBe("CENTRAL");
    expect(normalizeAuthMode("unknown")).toBe("LOCAL");
    expect(CENTRAL_FOUNDATION_EFFECTIVE_AUTH_MODE).toBe("LOCAL");
  });

  it("deviceId 使用稳定存储所需的随机 UUID 格式，不依赖硬件指纹", () => {
    const first = createRandomDeviceId();
    const second = createRandomDeviceId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(second).not.toBe(first);
    const source = fs.readFileSync(
      path.resolve("lib/central/device-id.ts"),
      "utf8",
    );
    expect(source).toContain("randomUUID");
    expect(source).not.toMatch(
      /wmic|serialnumber|networkInterfaces|macAddress|machineId/iu,
    );
  });

  it("使用汇总只保留显式白名单字段", () => {
    const draft = pickUsageSyncDraft({
      ...usage,
      url: "https://www.xiaohongshu.com/explore/private",
      title: "敏感标题",
      body: "敏感正文",
      cookie: "secret",
      path: "C:\\Users\\example\\private",
    });
    expect(draft).toEqual(usage);
    expect(Object.keys(draft)).toEqual(
      CENTRAL_SYNC_FIELD_ALLOWLIST.usageSummary,
    );
    expect(JSON.stringify(draft)).not.toContain("敏感");
    expect(JSON.stringify(draft)).not.toContain("xiaohongshu.com");
  });

  it("识别顶层和嵌套的禁止同步字段", () => {
    expect(
      findDeniedSyncFields({
        deviceId: usage.deviceId,
        note: { noteId: "private-note", topicEvidence: ["#私密"] },
        log: { stack: "private stack" },
      }),
    ).toEqual([
      "note.noteId",
      "note.topicEvidence",
      "log",
      "log.stack",
    ]);
    expect(CENTRAL_SYNC_DENIED_DATA.length).toBeGreaterThanOrEqual(7);
  });

  it("中央契约保持草案状态，运行时代码不包含中央网络调用", () => {
    const openapi = fs.readFileSync(
      path.resolve("docs/central-foundation/openapi.yaml"),
      "utf8",
    );
    expect(openapi).toContain(
      "x-veridia-implementation-status: draft-no-client-calls",
    );
    expect(openapi).toContain("https://control.example.invalid");

    const runtimeFiles = [
      "lib/central/contracts.ts",
      "lib/central/device-id.ts",
      "lib/central/privacy.ts",
      "lib/central/foundation.ts",
    ];
    for (const file of runtimeFiles) {
      const source = fs.readFileSync(path.resolve(file), "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(|https?:\/\//u);
    }
  });
});
