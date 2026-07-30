import builtinTemplateJson from "@/rules/default-import-export-templates.json";
import { prisma } from "@/lib/db";
import type { ImportExportTemplates } from "./types";
import { validateImportExportTemplates } from "./validation";

export const BUILTIN_IMPORT_EXPORT_TEMPLATES =
  validateImportExportTemplates(builtinTemplateJson);

export async function getActiveImportExportTemplates(): Promise<{
  templates: ImportExportTemplates;
  source: "BUILTIN" | "RULE_PACKAGE";
  ruleVersion: string | null;
}> {
  try {
    const state = await prisma.ruleSyncState.findUnique({
      where: { id: "active" },
      select: {
        currentVersion: true,
        templateConfigJson: true,
      },
    });
    if (state?.templateConfigJson) {
      return {
        templates: validateImportExportTemplates(
          JSON.parse(state.templateConfigJson),
        ),
        source: "RULE_PACKAGE",
        ruleVersion: state.currentVersion,
      };
    }
    return {
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
      source: "BUILTIN",
      ruleVersion: state?.currentVersion || null,
    };
  } catch {
    return {
      templates: BUILTIN_IMPORT_EXPORT_TEMPLATES,
      source: "BUILTIN",
      ruleVersion: null,
    };
  }
}
