import { invoke } from "@tauri-apps/api/core";

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
  appVersion: "0.1.23",
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
