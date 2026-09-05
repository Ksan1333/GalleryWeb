import { useState } from "react";

import {
  commitAndroidMigrationArchive,
  exportSettingsBackup,
  getPreferences,
  importSettingsBackup,
  listMediaItems,
  pickAndroidMigrationArchive,
  type MigrationArchivePreview,
  type MigrationImportResult,
  type MigrationUnresolvedMedia,
} from "../services/native";
import { announceThemePreferences } from "../services/theme";
import { configureNativeNotifications } from "../services/notifications";
import { Icon } from "./Icon";
import { formatBytes } from "./Ui";

type DataPortabilitySettingsProps = {
  nativeAvailable: boolean;
  migrationFormatVersion: number;
  onDataChanged: () => void;
};

type ResolutionOption = {
  mediaId: string;
  fileName: string;
  relativePath: string;
  fileSize: number;
};

function MigrationResolutionEditor({
  item,
  selectedId,
  disabled,
  onSelect,
}: {
  item: MigrationUnresolvedMedia;
  selectedId?: string;
  disabled: boolean;
  onSelect: (mediaId?: string) => void;
}) {
  const [query, setQuery] = useState(item.fileName);
  const [searchResults, setSearchResults] = useState<ResolutionOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const options = [...item.candidates, ...searchResults].filter(
    (candidate, index, all) => all.findIndex((value) => value.mediaId === candidate.mediaId) === index,
  );

  async function searchCandidates() {
    setSearching(true);
    setSearchError(undefined);
    const response = await listMediaItems({ search: query.trim() || item.fileName, limit: 24 });
    setSearching(false);
    if (response.error) {
      setSearchError(response.error);
      return;
    }
    setSearchResults(response.data.map((media) => ({
      mediaId: media.id,
      fileName: media.name,
      relativePath: media.relativePath ?? media.path,
      fileSize: media.sizeBytes,
    })));
  }

  return (
    <article className="migration-resolution-item">
      <div className="migration-resolution-source">
        <span className={`state-chip${item.status === "missing" ? " warning" : ""}`}>
          {item.status === "ambiguous" ? "候補が複数" : "未検出"}
        </span>
        <span>
          <strong>{item.fileName}</strong>
          <small>{item.relativePath ?? "パス情報なし"} · {formatBytes(item.fileSize)}</small>
        </span>
      </div>
      <div className="migration-resolution-search">
        <label>
          <span className="sr-only">{item.fileName}の割り当て先を検索</span>
          <Icon name="search" />
          <input
            type="search"
            value={query}
            disabled={disabled || searching}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void searchCandidates();
              }
            }}
          />
        </label>
        <button className="secondary-button" type="button" disabled={disabled || searching} onClick={() => void searchCandidates()}>
          {searching ? "検索中…" : "登録済みメディアを検索"}
        </button>
      </div>
      {searchError && <small className="migration-resolution-error">{searchError}</small>}
      <div className="migration-resolution-options" role="radiogroup" aria-label={`${item.fileName}の割り当て先`}>
        <button
          type="button"
          className={!selectedId ? "active" : undefined}
          aria-pressed={!selectedId}
          disabled={disabled}
          onClick={() => onSelect(undefined)}
        >
          <Icon name={!selectedId ? "check" : "close"} />
          <span><strong>割り当てずにスキップ</strong><small>この項目のデータは変更しません</small></span>
        </button>
        {options.map((candidate) => (
          <button
            type="button"
            key={candidate.mediaId}
            className={selectedId === candidate.mediaId ? "active" : undefined}
            aria-pressed={selectedId === candidate.mediaId}
            disabled={disabled}
            onClick={() => onSelect(candidate.mediaId)}
          >
            <Icon name={selectedId === candidate.mediaId ? "check" : "image"} />
            <span>
              <strong>{candidate.fileName}</strong>
              <small>{candidate.relativePath} · {formatBytes(candidate.fileSize)}</small>
            </span>
          </button>
        ))}
        {options.length === 0 && (
          <small>候補はありません。上の検索欄から登録済みメディアを探せます。</small>
        )}
      </div>
    </article>
  );
}

export function DataPortabilitySettings({
  nativeAvailable,
  migrationFormatVersion,
  onDataChanged,
}: DataPortabilitySettingsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [preview, setPreview] = useState<MigrationArchivePreview>();
  const [result, setResult] = useState<MigrationImportResult>();
  const [resolutions, setResolutions] = useState<Record<string, string>>({});

  async function exportBackup() {
    setError(undefined);
    setMessage(undefined);
    setBusy(true);
    const response = await exportSettingsBackup();
    setBusy(false);
    if (!response.available || response.error) {
      setError(response.error ?? "設定バックアップを書き出せませんでした。");
      return;
    }
    if (response.data) {
      setMessage(`設定 ${response.data.preferences}件を ${response.data.path} へ保存しました。`);
    }
  }

  async function importBackup() {
    setError(undefined);
    setMessage(undefined);
    setBusy(true);
    const response = await importSettingsBackup();
    if (!response.available || response.error) {
      setBusy(false);
      setError(response.error ?? "設定バックアップを復元できませんでした。");
      return;
    }
    if (response.data) {
      const refreshed = await getPreferences();
      if (refreshed.error || !refreshed.available) {
        setBusy(false);
        setError(`設定は復元しましたが、表示への反映に失敗しました。アプリを再起動してください。${refreshed.error ?? ""}`);
        onDataChanged();
        return;
      }
      announceThemePreferences(refreshed.data);
      configureNativeNotifications(refreshed.data.nativeNotifications);
      setMessage(`設定 ${response.data.preferences}件を復元しました。`);
      onDataChanged();
    }
    setBusy(false);
  }

  async function chooseMigrationArchive() {
    setError(undefined);
    setMessage(undefined);
    setPreview(undefined);
    setResult(undefined);
    setResolutions({});
    setBusy(true);
    const response = await pickAndroidMigrationArchive();
    setBusy(false);
    if (!response.available || response.error) {
      setError(response.error ?? "Android移行ZIPを確認できませんでした。");
      return;
    }
    if (response.data) setPreview(response.data);
  }

  async function commitMigrationArchive() {
    if (!preview) return;
    setError(undefined);
    setBusy(true);
    const response = await commitAndroidMigrationArchive(preview.token, resolutions);
    setBusy(false);
    if (!response.available || response.error || !response.data) {
      setError(response.error ?? "移行内容を保存できませんでした。");
      return;
    }
    setResult(response.data);
    setPreview(undefined);
    onDataChanged();
  }

  return (
    <>
      {(error || message) && (
        <div className={`operation-message${error ? " error" : " success"}`} role={error ? "alert" : "status"}>
          <Icon name={error ? "warning" : "check"} />
          {error ?? message}
        </div>
      )}

      {result && (
        <div className="operation-message success" role="status">
          <Icon name="check" />
          {result.alreadyImported ? (
            <span>同じSHA-256の移行ZIPは取り込み済みです。重複登録は行いませんでした。</span>
          ) : (
            <span>
              メディア {result.importedMedia}件、タグ {result.importedTags}件、しおり {result.importedBookmarks}件、
              資料 {result.importedReferenceProjects}プロジェクト／{result.importedReferenceItems}項目、
              X履歴 {result.importedXHistory}件を取り込みました。スキップは {result.skippedMedia}件です。
            </span>
          )}
        </div>
      )}

      <section className="settings-panel">
        <div className="section-heading">
          <div>
            <p className="kicker">SETTINGS BACKUP</p>
            <h2>設定をバックアップ</h2>
          </div>
        </div>
        <p className="muted-copy">
          表示設定、お気に入りサイト／クリエイター、資料プロジェクトなどを1つのJSONへ保存・復元します。
          メディア本体、タグ、AI分析結果は含みません。
        </p>
        <div className="settings-backup-actions">
          <button className="primary-button" type="button" disabled={busy || !nativeAvailable} onClick={() => void exportBackup()}>
            <Icon name="download" />{busy ? "処理中…" : "JSONへ書き出す"}
          </button>
          <button className="secondary-button" type="button" disabled={busy || !nativeAvailable} onClick={() => void importBackup()}>
            <Icon name="upload" />JSONから復元
          </button>
        </div>
      </section>

      <section className="settings-panel migration-section">
        <div className="section-heading">
          <div>
            <p className="kicker">ANDROID MIGRATION</p>
            <h2>Android版データを移行</h2>
          </div>
          <span className="state-chip">形式 v{migrationFormatVersion}</span>
        </div>
        <p className="muted-copy">
          Android版のチェックサム付きZIPを検証し、登録済みファイルと照合してから、タグ、お気に入り、しおり、資料、X保存履歴を取り込みます。
        </p>
        <ol>
          <li><span>1</span>Android版でWindows移行用ZIPを書き出す</li>
          <li><span>2</span>メディア本体をWindowsへコピーしてフォルダーを登録・スキャンする</li>
          <li><span>3</span>移行ZIPを選び、照合結果を確認して確定する</li>
        </ol>
        <button className="primary-button" type="button" disabled={busy || !nativeAvailable} onClick={() => void chooseMigrationArchive()}>
          <Icon name="upload" />{busy ? "検証中…" : "移行ZIPを選択して検証"}
        </button>

        {preview && (
          <div className="migration-preview" role="region" aria-label="移行内容の事前確認">
            <div className="migration-preview-heading">
              <div>
                <strong>{preview.sourceName}</strong>
                <small>Android {preview.androidVersion} · {preview.exportedAt}</small>
              </div>
              <span className={`state-chip${preview.ambiguousMedia + preview.missingMedia > 0 ? " warning" : ""}`}>
                {preview.alreadyImported ? "取り込み済み" : "検証済み"}
              </span>
            </div>
            <dl className="migration-preview-counts">
              <div><dt>メディア</dt><dd>{preview.totalMedia}件</dd></div>
              <div><dt>一致</dt><dd>{preview.matchedMedia}件</dd></div>
              <div><dt>曖昧</dt><dd>{preview.ambiguousMedia}件</dd></div>
              <div><dt>未検出</dt><dd>{preview.missingMedia}件</dd></div>
              <div><dt>タグ</dt><dd>{preview.tagRecords}件</dd></div>
              <div><dt>しおり</dt><dd>{preview.matchedBookmarks}/{preview.bookmarkRecords}件</dd></div>
              <div><dt>資料</dt><dd>{preview.referenceRecords}件</dd></div>
              <div><dt>X履歴</dt><dd>{preview.xHistoryRecords}件</dd></div>
            </dl>
            {preview.issueCount > 0 && (
              <div className="migration-issues">
                <strong>自動取り込みしない項目: {preview.issueCount}件</strong>
                <p>候補が複数ある項目は自動では割り当てません。必要な項目だけ下で個別に指定できます。</p>
                <ul>
                  {preview.issues.map((issue, index) => (
                    <li key={`${issue.sourceIdentity}-${index}`}>{issue.message}</li>
                  ))}
                </ul>
                {preview.issueCount > preview.issues.length && (
                  <small>ほか {preview.issueCount - preview.issues.length}件</small>
                )}
              </div>
            )}
            {preview.unresolvedMedia.length > 0 && (
              <div className="migration-resolution-list">
                <div className="migration-resolution-heading">
                  <span>
                    <strong>未解決メディアを手動で割り当て</strong>
                    <small>{Object.keys(resolutions).length} / {preview.unresolvedMedia.length}件を指定済み</small>
                  </span>
                  <span className="state-chip">任意</span>
                </div>
                {preview.unresolvedMedia.map((item) => (
                  <MigrationResolutionEditor
                    key={item.sourceIdentity}
                    item={item}
                    selectedId={resolutions[item.sourceIdentity]}
                    disabled={busy}
                    onSelect={(mediaId) => setResolutions((current) => {
                      const next = { ...current };
                      if (mediaId) next[item.sourceIdentity] = mediaId;
                      else delete next[item.sourceIdentity];
                      return next;
                    })}
                  />
                ))}
              </div>
            )}
            <div className="migration-preview-actions">
              <button className="primary-button" type="button" disabled={busy} onClick={() => void commitMigrationArchive()}>
                <Icon name="check" />
                {preview.alreadyImported
                  ? "取り込み済みを確認"
                  : Object.keys(resolutions).length > 0
                    ? `手動割り当て${Object.keys(resolutions).length}件を含めて取り込む`
                    : "一致したデータを取り込む"}
              </button>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setPreview(undefined)}>
                キャンセル
              </button>
            </div>
            <small className="migration-sha">SHA-256: {preview.sourceSha256}</small>
          </div>
        )}
      </section>
    </>
  );
}

export default DataPortabilitySettings;
