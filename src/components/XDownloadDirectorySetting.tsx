import { useCallback, useEffect, useState } from "react";
import {
  getDefaultXDownloadDirectory,
  getJsonPreference,
  pickXDownloadFolder,
  setJsonPreference,
} from "../services/native";
import { startOperation, type OperationHandle } from "../services/operations";
import { Icon } from "./Icon";

export const X_DOWNLOAD_DIRECTORY_KEY = "x.downloadDirectory";
export const X_DOWNLOAD_DIRECTORY_CHANGED_EVENT = "pixvault:x-download-directory-changed";

export function XDownloadDirectorySetting({ compact = false }: { compact?: boolean }) {
  const [directory, setDirectory] = useState("");
  const [defaultDirectory, setDefaultDirectory] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    const [preference, systemDefault] = await Promise.all([
      getJsonPreference<string>(X_DOWNLOAD_DIRECTORY_KEY, ""),
      getDefaultXDownloadDirectory(),
    ]);
    const fallback = systemDefault.data || "Downloads";
    setDefaultDirectory(fallback);
    setDirectory(preference.data?.trim() || fallback);
    setError(preference.error || systemDefault.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const synchronize = (event: Event) => {
      const nextDirectory = (event as CustomEvent<unknown>).detail;
      if (typeof nextDirectory === "string" && nextDirectory) {
        setDirectory(nextDirectory);
      }
    };
    window.addEventListener(X_DOWNLOAD_DIRECTORY_CHANGED_EVENT, synchronize);
    return () => window.removeEventListener(X_DOWNLOAD_DIRECTORY_CHANGED_EVENT, synchronize);
  }, [load]);

  async function saveDirectory(nextDirectory: string, activeOperation?: OperationHandle) {
    const operation = activeOperation ?? startOperation({
      label: "Xの保存先を変更",
      detail: "設定を保存しています",
      progress: null,
    });
    setSaving(true);
    setError(undefined);
    const result = await setJsonPreference(X_DOWNLOAD_DIRECTORY_KEY, nextDirectory);
    setSaving(false);
    if (result.error || !result.data) {
      const message = result.error ?? "保存先を変更できませんでした。";
      setError(message);
      operation.fail(message);
      return;
    }
    setDirectory(nextDirectory || defaultDirectory || "Downloads");
    operation.succeed(nextDirectory ? "新しい保存先を設定しました" : "Downloadsへ戻しました");
    window.dispatchEvent(
      new CustomEvent(X_DOWNLOAD_DIRECTORY_CHANGED_EVENT, {
        detail: nextDirectory || defaultDirectory,
      }),
    );
  }

  async function chooseDirectory() {
    const operation = startOperation({
      label: "Xの保存先を変更",
      detail: "保存先フォルダーを選択しています",
      progress: null,
    });
    setSaving(true);
    setError(undefined);
    const picked = await pickXDownloadFolder();
    setSaving(false);
    if (picked.error) {
      setError(picked.error);
      operation.fail(picked.error);
      return;
    }
    if (!picked.data) {
      operation.cancel("保存先の変更をキャンセルしました");
      return;
    }
    operation.update({ detail: "設定を保存しています" });
    await saveDirectory(picked.data, operation);
  }

  return (
    <section className={`x-download-directory ${compact ? "is-compact" : ""}`}>
      <div className="x-download-directory-icon"><Icon name="folder" /></div>
      <div className="x-download-directory-copy">
        <span>Xメディアの保存先</span>
        <strong title={directory}>{loading ? "保存先を確認中…" : directory || "Downloads"}</strong>
        <small>未設定の場合はWindowsのDownloadsフォルダーを使用します。</small>
        {error && <em role="alert"><Icon name="warning" />{error}</em>}
      </div>
      <div className="x-download-directory-actions">
        <button className="secondary-button" type="button" onClick={() => void chooseDirectory()} disabled={loading || saving}>
          <Icon name="folderPlus" />{saving ? "変更中…" : "保存先を選択"}
        </button>
        {directory && defaultDirectory && directory !== defaultDirectory && (
          <button className="text-button" type="button" onClick={() => void saveDirectory("")} disabled={saving}>
            既定に戻す
          </button>
        )}
      </div>
    </section>
  );
}
