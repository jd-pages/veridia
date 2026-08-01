export type RuntimeEnvironment = Record<string, string | undefined>;

export const LOCAL_PREVIEW_USER_ID = "veridia-local-preview-user";
export const LOCAL_PREVIEW_USERNAME = "terry-preview";
export const LOCAL_PREVIEW_DISPLAY_NAME = "Terry Preview";

export function isLocalPreviewMode(
  environment: RuntimeEnvironment = process.env,
) {
  return (
    environment.VERIDIA_LOCAL_PREVIEW === "1" &&
    environment.VERIDIA_RUNTIME_KIND === "source-preview" &&
    environment.NODE_ENV === "development" &&
    environment.VERIDIA_DESKTOP !== "true" &&
    environment.VERIDIA_PACKAGED !== "true"
  );
}

export function isIsolatedLocalPreview(
  environment: RuntimeEnvironment = process.env,
) {
  return (
    isLocalPreviewMode(environment) &&
    environment.VERIDIA_PREVIEW_DATA_MODE === "isolated"
  );
}
