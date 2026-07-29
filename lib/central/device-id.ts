import { randomUUID } from "node:crypto";

export const PRIMARY_LOCAL_DEVICE_ID = "primary-device";

export function createRandomDeviceId() {
  return randomUUID();
}
