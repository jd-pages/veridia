export {};

declare global {
  interface VeridiaDataLocationResult {
    success: boolean;
    dataDirectory?: string;
    fileCount?: number;
    error?: string;
  }

  interface VeridiaExportSaveResult {
    success: boolean;
    canceled?: boolean;
    filePath?: string;
    error?: string;
  }

  interface Window {
    veridiaDesktop?: {
      getSystemInfo(): Promise<{
        version: string;
        buildDate: string | null;
        databaseVersion: string;
        dataDirectory: string;
        packaged: boolean;
      }>;
      getDataLocation(): Promise<{
        confirmed: boolean;
        defaultDirectory: string;
        currentDirectory: string;
        installDirectory: string;
      }>;
      chooseDataDirectory(): Promise<VeridiaDataLocationResult | null>;
      confirmDataDirectory(
        dataDirectory: string,
      ): Promise<VeridiaDataLocationResult>;
      migrateDataDirectory(
        dataDirectory: string,
      ): Promise<VeridiaDataLocationResult>;
      storePersistentSession(token: string): Promise<boolean>;
      clearPersistentSession(): Promise<boolean>;
      saveExportFile(payload: {
        fileName: string;
        data: Uint8Array;
        kind?: "audit-export" | "import-template";
      }): Promise<VeridiaExportSaveResult>;
    };
  }
}
