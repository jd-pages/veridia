import type {
  ImportExportTemplates,
  TabularPreview,
  TabularSourceType,
} from "@/lib/import-export-templates/types";

export interface TabularSourceInput {
  type: TabularSourceType;
  name: string;
  bytes?: Uint8Array;
  onlineUrl?: string;
}

export interface TabularSourceAdapter {
  readonly supportedTypes: readonly TabularSourceType[];
  preview(
    input: TabularSourceInput,
    templates: ImportExportTemplates,
  ): Promise<TabularPreview>;
}

export interface OnlineTabularSourceAdapter extends TabularSourceAdapter {
  authorizationStatus(): Promise<"UNAVAILABLE" | "REQUIRED" | "READY">;
  writeBack?(
    input: TabularSourceInput,
    rows: ReadonlyArray<Record<string, string>>,
  ): Promise<void>;
}

// TENCENT_DOCS_ONLINE_LINK is intentionally interface-only. Real online
// reading, authorization and write-back require a future signed software
// update; a remotely updated rules package may only change local mappings.
