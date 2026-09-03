import { invoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "./appVersion";

export type RuntimeInfo = {
  appName: string;
  appVersion: string;
  os: string;
  arch: string;
  databaseSchemaVersion: number;
  migrationFormatVersion: number;
};

const browserFallback: RuntimeInfo = {
  appName: "PixVault for Windows",
  appVersion: APP_VERSION,
  os: "browser preview",
  arch: "web",
  databaseSchemaVersion: 8,
  migrationFormatVersion: 1,
};

export async function loadRuntimeInfo(): Promise<RuntimeInfo> {
  try {
    return await invoke<RuntimeInfo>("get_runtime_info");
  } catch {
    return browserFallback;
  }
}
