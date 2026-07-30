export {};

declare global {
  interface VeridiaUpdateInfo {
    version: string;
    releaseName?: string;
    releaseNotes?: string;
    releaseDate?: string;
  }

  interface VeridiaUpdateStatus {
    state:
      | "idle"
      | "checking"
      | "available"
      | "not-available"
      | "downloading"
      | "downloaded"
      | "error";
    version?: string;
    info?: VeridiaUpdateInfo;
    percent?: number;
    transferred?: number;
    total?: number;
    bytesPerSecond?: number;
    message?: string;
    manual?: boolean;
  }

  interface VeridiaDataLocationResult {
    success: boolean;
    dataDirectory?: string;
    fileCount?: number;
    error?: string;
  }

  interface Window {
    veridiaDesktop?: {
      getSystemInfo(): Promise<{
        version: string;
        buildDate: string | null;
        databaseVersion: string;
        dataDirectory: string;
        autoUpdate: boolean;
        packaged: boolean;
        updateStatus: VeridiaUpdateStatus;
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
      checkForUpdates(): Promise<void>;
      downloadUpdate(): Promise<boolean>;
      installUpdate(): Promise<boolean>;
      setAutoUpdate(enabled: boolean): Promise<boolean>;
      openReleaseNotes(): Promise<boolean>;
      getUpdateStatus(): Promise<VeridiaUpdateStatus>;
      storePersistentSession(token: string): Promise<boolean>;
      clearPersistentSession(): Promise<boolean>;
      onUpdateStatus(
        listener: (status: VeridiaUpdateStatus) => void,
      ): () => void;
    };
  }
}
