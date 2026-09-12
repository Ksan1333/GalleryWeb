import { useEffect, useState } from "react";
import {
  commitAndroidMigrationArchive,
  createCatalogRecoverySnapshot,
  defaultPreferences,
  exportSettingsBackup,
  exportDiagnosticsReport,
  getSystemDiagnostics,
  getPreferences,
  importSettingsBackup,
  listXHistory,
  optimizeCatalog,
  pickAndroidMigrationArchive,
  setPreference,
  showWindowsNotification,
  type LibraryRoot,
  type LibrarySummary,
  type MigrationArchivePreview,
  type MigrationImportResult,
  type RuntimeInfo,
  type SystemDiagnostics,
  type UserPreferences,
  type XHistoryItem,
} from "../services/native";
import { Icon } from "../components/Icon";
import {
  EmptyState,
  LoadingPanel,
  NativePreviewNotice,
  PageHeader,
  SelectMenu,
  StatusPanel,
  formatBytes,
  formatCount,
  formatDate,
} from "../components/Ui";
import {
  announceThemePreferences,
  themePresets,
  type ThemePresetId,
} from "../services/theme";
import { configureNativeNotifications } from "../services/notifications";

export type AppSection =
  | "home"
  | "gallery"
  | "videos"
  | "books"
  | "references"
  | "favorites"
  | "analysis"
  | "downloads"
  | "settings";

type HomePageProps = {
  runtimeInfo: RuntimeInfo;
  summary: LibrarySummary;
  roots: LibraryRoot[];
  loading: boolean;
  nativeAvailable: boolean;
  error?: string;
  busy: boolean;
  onNavigate: (section: AppSection) => void;
  onAddFolder: () => void;
  onScan: (rootId?: string) => void;
};

export function HomePage({
  runtimeInfo,
  summary,
  roots,
  loading,
  nativeAvailable,
  error,
  busy,
  onNavigate,
  onAddFolder,
  onScan,
}: HomePageProps) {
  return (
    <div className="page home-page">
      {!nativeAvailable && <NativePreviewNotice />}
      {error && (
        <StatusPanel tone="error" icon="warning" title="ライブラリー情報を取得できませんでした">
          <p>{error}</p>
        </StatusPanel>
      )}

      <section className="hero">
        <div>
          <p className="kicker">WINDOWS MEDIA LIBRARY</p>
          <h1>大切なメディアを、<br />このPCでひとつに。</h1>
          <p className="hero-copy">
            画像・GIF・動画・本・資料をローカルで整理します。登録したフォルダーの中身は、
            明示的な操作がない限り変更しません。
          </p>
          <div className="hero-actions">
            <button className="primary-button" type="button" onClick={onAddFolder} disabled={busy || !nativeAvailable}>
              <Icon name="folderPlus" />
              メディア優先フォルダーを追加
            </button>
            <button className="secondary-button" type="button" onClick={() => onScan()} disabled={busy || roots.length === 0}>
              <Icon name="refresh" className={busy ? "rotating" : undefined} />
              全体を再スキャン
            </button>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="art-card card-back"><span /></div>
          <div className="art-card card-front">
            <div className="art-sun" />
            <div className="art-mountain mountain-one" />
            <div className="art-mountain mountain-two" />
          </div>
          <div className="sparkle sparkle-one">✦</div>
          <div className="sparkle sparkle-two">✦</div>
        </div>
      </section>

      <section aria-labelledby="summary-title">
        <div className="section-heading">
          <div>
            <p className="kicker">LIBRARY STATUS</p>
            <h2 id="summary-title">ライブラリー</h2>
          </div>
          <span className="version-chip">
            移行形式 v{runtimeInfo.migrationFormatVersion} · DB v{runtimeInfo.databaseSchemaVersion}
          </span>
        </div>
        {loading ? (
          <LoadingPanel label="ライブラリーを確認中…" />
        ) : (
          <div className="stat-grid">
            <button type="button" onClick={() => onNavigate("gallery")}>
              <Icon name="image" />
              <span>画像・GIF</span>
              <strong>{formatCount(summary.images + summary.gifs)}</strong>
            </button>
            <button type="button" onClick={() => onNavigate("videos")}>
              <Icon name="video" />
              <span>動画</span>
              <strong>{formatCount(summary.videos)}</strong>
            </button>
            <button type="button" onClick={() => onNavigate("books")}>
              <Icon name="book" />
              <span>本・PDF</span>
              <strong>{formatCount(summary.books)}</strong>
            </button>
            <button type="button" onClick={() => onNavigate("favorites")}>
              <Icon name="star" />
              <span>お気に入り</span>
              <strong>{formatCount(summary.favorites)}</strong>
            </button>
            <div>
              <Icon name="tag" />
              <span>タグ</span>
              <strong>{formatCount(summary.tags)}</strong>
            </div>
            <div>
              <Icon name="hardDrive" />
              <span>カタログ容量</span>
              <strong>{formatBytes(summary.storageBytes)}</strong>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="start-title">
        <div className="section-heading">
          <div>
            <p className="kicker">GET STARTED</p>
            <h2 id="start-title">セットアップ</h2>
          </div>
        </div>
        <div className="setup-grid">
          <article className="setup-card violet">
            <div className="card-icon"><Icon name="folder" /></div>
            <p className="card-eyebrow">STEP 1</p>
            <h3>Windowsフォルダーを登録</h3>
            <p>フォルダーを選び、画像・GIF・動画・本・資料の索引を作ります。</p>
            <button type="button" onClick={onAddFolder} disabled={busy || !nativeAvailable}>
              フォルダーを選択 <Icon name="arrowRight" />
            </button>
          </article>
          <article className="setup-card blue">
            <div className="card-icon"><Icon name="download" /></div>
            <p className="card-eyebrow">ANDROID DATA</p>
            <h3>Android版から移行</h3>
            <p>タグ、お気に入り、設定、X保存履歴を検証してカタログへ取り込みます。</p>
            <button type="button" onClick={() => onNavigate("settings")}>
              移行画面を開く <Icon name="arrowRight" />
            </button>
          </article>
          <article className="setup-card rose">
            <div className="card-icon"><Icon name="sparkles" /></div>
            <p className="card-eyebrow">LOCAL AI</p>
            <h3>AI解析の準備状態</h3>
            <p>ローカル推論モデルと解析対象の接続状況を確認できます。</p>
            <button type="button" onClick={() => onNavigate("analysis")}>
              準備状態を見る <Icon name="arrowRight" />
            </button>
          </article>
        </div>
      </section>

      <section className="library-roots-card" aria-labelledby="root-title">
        <div>
          <p className="kicker">WATCHED FOLDERS</p>
          <h2 id="root-title">優先フォルダー</h2>
          <p>最終スキャン: {formatDate(summary.lastScannedAt)}</p>
        </div>
        {roots.length === 0 ? (
          <div className="root-empty">
            <Icon name="folder" />
            <span>まだ登録されていません</span>
          </div>
        ) : (
          <div className="root-chips">
            {roots.slice(0, 4).map((root) => (
              <button type="button" key={root.id} onClick={() => onScan(root.id)} disabled={busy}>
                <Icon name="folder" />
                <span><strong>{root.displayName}</strong><small>{formatCount(root.mediaCount)}件</small></span>
              </button>
            ))}
            {roots.length > 4 && <span className="more-chip">ほか {roots.length - 4}件</span>}
          </div>
        )}
      </section>
    </div>
  );
}

export function AnalysisPage({
  summary,
  roots,
  nativeAvailable,
}: {
  summary: LibrarySummary;
  roots: LibraryRoot[];
  nativeAvailable: boolean;
}) {
  const checks = [
    {
      label: "Windowsアプリとの接続",
      ready: nativeAvailable,
      detail: nativeAvailable ? "ネイティブ処理を利用できます" : "ブラウザプレビューでは利用できません",
    },
    {
      label: "解析対象のメディア",
      ready: summary.totalItems > 0,
      detail: summary.totalItems > 0 ? `${formatCount(summary.totalItems)}件を検出` : "フォルダーの登録とスキャンが必要です",
    },
    {
      label: "ローカルAIモデル",
      ready: false,
      detail: "推論ランタイムとモデル管理は未接続です",
    },
  ];

  return (
    <div className="page">
      <PageHeader
        eyebrow="LOCAL AI"
        title="AI解析"
        description="画像の自動タグ付け、特徴ベクトル、類似検索をPC内で実行するための準備状態です。"
      />
      {!nativeAvailable && <NativePreviewNotice />}
      <StatusPanel tone="warning" icon="warning" title="AI推論はまだ実行できません">
        <p>
          現在はカタログとUIのみ接続済みです。モデルの取得、ONNX推論、解析結果の保存が接続されるまで開始操作は無効です。
        </p>
      </StatusPanel>

      <div className="analysis-layout">
        <section className="panel analysis-readiness">
          <div className="panel-heading">
            <div><p className="kicker">READINESS</p><h2>準備チェック</h2></div>
            <span>{checks.filter((check) => check.ready).length} / {checks.length}</span>
          </div>
          <div className="check-list">
            {checks.map((check) => (
              <div className={check.ready ? "ready" : ""} key={check.label}>
                <span><Icon name={check.ready ? "check" : "clock"} /></span>
                <div><strong>{check.label}</strong><small>{check.detail}</small></div>
              </div>
            ))}
          </div>
        </section>
        <section className="panel analysis-job">
          <p className="kicker">ANALYSIS JOB</p>
          <h2>ライブラリー全体を解析</h2>
          <p>{roots.length}フォルダー、{formatCount(summary.images + summary.gifs)}画像が対象候補です。</p>
          <div className="progress-track" aria-label="解析進捗 0%">
            <span style={{ width: "0%" }} />
          </div>
          <div className="progress-label"><span>待機中</span><strong>0%</strong></div>
          <button className="primary-button" type="button" disabled>
            <Icon name="sparkles" />解析を開始
          </button>
        </section>
      </div>

      <section className="panel capability-grid" aria-labelledby="ai-capability-title">
        <div className="panel-heading">
          <div><p className="kicker">PLANNED CAPABILITIES</p><h2 id="ai-capability-title">実装対象</h2></div>
        </div>
        <div>
          <article><Icon name="tag" /><strong>自動タグ</strong><p>画像内容の候補タグを付与し、確認後に保存します。</p><span>未接続</span></article>
          <article><Icon name="search" /><strong>類似画像</strong><p>特徴ベクトルから見た目の近いメディアを探します。</p><span>未接続</span></article>
          <article><Icon name="database" /><strong>ローカル保存</strong><p>モデルと解析結果を外部送信せずSQLiteへ保存します。</p><span>未接続</span></article>
        </div>
      </section>
    </div>
  );
}

export function DownloadsPage({ nativeAvailable }: { nativeAvailable: boolean }) {
  const [history, setHistory] = useState<XHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [url, setUrl] = useState("");

  useEffect(() => {
    let active = true;
    void listXHistory().then((result) => {
      if (!active) return;
      setHistory(result.data);
      setError(result.error);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const validUrl = /^https:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(url.trim());

  return (
    <div className="page">
      <PageHeader
        eyebrow="X MEDIA"
        title="Xから保存"
        description="投稿URLを受け取り、品質を確認してローカルライブラリーへ保存する画面です。"
      />
      {!nativeAvailable && <NativePreviewNotice />}
      <StatusPanel tone="warning" icon="warning" title="メディア取得エンジンは未接続です">
        <p>URL解析・品質選択・ダウンロード処理の接続までは、保存操作を実行しません。移行済みの履歴は下で確認できます。</p>
      </StatusPanel>
      {error && <StatusPanel tone="error" icon="warning" title="X保存履歴を読み込めませんでした"><p>{error}</p></StatusPanel>}

      <section className="panel x-input-panel" aria-labelledby="x-save-title">
        <div className="panel-heading">
          <div><p className="kicker">POST URL</p><h2 id="x-save-title">投稿を指定</h2></div>
          <span className="state-chip waiting">エンジン待ち</span>
        </div>
        <label>
          <span>Xの投稿URL</span>
          <div>
            <input
              type="url"
              inputMode="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://x.com/…/status/…"
              aria-describedby="x-url-help"
            />
            <button className="primary-button" type="button" disabled title="取得エンジンの接続後に利用できます">
              <Icon name="download" />候補を取得
            </button>
          </div>
          <small id="x-url-help">
            {!url ? "XまたはTwitterの投稿URLを貼り付けます。" : validUrl ? "URL形式を確認しました。取得処理は未接続です。" : "対応する投稿URLではありません。"}
          </small>
        </label>
      </section>

      <section className="panel" aria-labelledby="x-history-title">
        <div className="panel-heading">
          <div><p className="kicker">HISTORY</p><h2 id="x-history-title">保存履歴</h2></div>
          <span>{history.length}件</span>
        </div>
        {loading ? (
          <LoadingPanel label="履歴を読み込み中…" />
        ) : history.length === 0 ? (
          <EmptyState icon="download" title="保存履歴はありません" description="Android版から移行した履歴もここに表示されます。" />
        ) : (
          <div className="history-list">
            {history.map((item) => (
              <article key={item.id}>
                <div className={`history-status ${item.status}`}><Icon name={item.status === "saved" ? "check" : item.status === "failed" ? "warning" : "clock"} /></div>
                <div>
                  <strong>{item.title || item.url}</strong>
                  <a href={item.url} target="_blank" rel="noreferrer">{item.url}<Icon name="external" /></a>
                  <small>{formatDate(item.createdAt)}{item.author ? ` · ${item.author}` : ""}</small>
                  {item.error && <p>{item.error}</p>}
                </div>
                <span className={`state-chip ${item.status}`}>{item.status === "saved" ? "保存済み" : item.status === "failed" ? "失敗" : "待機"}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

type SettingsPageProps = {
  runtimeInfo: RuntimeInfo;
  roots: LibraryRoot[];
  nativeAvailable: boolean;
  busy: boolean;
  onAddFolder: () => void;
  onScan: (rootId?: string) => void;
  onRemoveRoot: (root: LibraryRoot) => void;
  onCatalogImported: () => void;
};

export function SettingsPage({
  runtimeInfo,
  roots,
  nativeAvailable,
  busy,
  onAddFolder,
  onScan,
  onRemoveRoot,
  onCatalogImported,
}: SettingsPageProps) {
  const [preferences, setPreferences] = useState<UserPreferences>(defaultPreferences);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [savingKey, setSavingKey] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<MigrationArchivePreview>();
  const [importResult, setImportResult] = useState<MigrationImportResult>();
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics>();
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<string>();

  useEffect(() => {
    let active = true;
    void getPreferences().then((result) => {
      if (!active) return;
      setPreferences(result.data);
      announceThemePreferences(result.data);
      configureNativeNotifications(result.data.nativeNotifications);
      setError(result.error);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  async function updatePreference<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) {
    const previous = preferences[key];
    const nextPreferences = { ...preferences, [key]: value };
    setPreferences(nextPreferences);
    announceThemePreferences(nextPreferences);
    configureNativeNotifications(nextPreferences.nativeNotifications);
    setSavingKey(String(key));
    const result = await setPreference(key, value);
    setSavingKey(undefined);
    if (result.error || !result.available) {
      const reverted = { ...nextPreferences, [key]: previous };
      setPreferences(reverted);
      announceThemePreferences(reverted);
      configureNativeNotifications(reverted.nativeNotifications);
      setError(result.error ?? "ブラウザプレビューでは設定を保存できません。");
    }
  }

  async function testNativeNotification() {
    setError(undefined);
    const result = await showWindowsNotification(
      "PixVaultの通知テスト",
      "Windows通知は正常に有効化されています。",
      "success",
    );
    if (!result.data || result.error) {
      setError(result.error ?? "この環境ではWindows通知を表示できませんでした。");
      return;
    }
    setBackupMessage("Windows通知を送信しました。");
  }

  async function inspectDiagnostics(runMaintenance = false) {
    setError(undefined);
    setDiagnosticsBusy(runMaintenance ? "optimize" : "inspect");
    const result = runMaintenance ? await optimizeCatalog() : await getSystemDiagnostics();
    setDiagnosticsBusy(undefined);
    if (!result.available || result.error) {
      setError(result.error ?? "この環境ではカタログ診断を実行できません。");
      return;
    }
    setDiagnostics(result.data);
    setBackupMessage(runMaintenance ? "安全なカタログメンテナンスが完了しました。" : "カタログの整合性を確認しました。");
  }

  async function exportDiagnostics() {
    setError(undefined);
    setDiagnosticsBusy("export");
    const result = await exportDiagnosticsReport();
    setDiagnosticsBusy(undefined);
    if (!result.available || result.error) {
      setError(result.error ?? "診断レポートを書き出せませんでした。");
      return;
    }
    if (result.data) {
      setBackupMessage(`個人情報を抑えた診断レポートを ${result.data.path} へ保存しました。`);
    }
  }

  async function createRecoverySnapshot() {
    setError(undefined);
    setDiagnosticsBusy("snapshot");
    const result = await createCatalogRecoverySnapshot();
    setDiagnosticsBusy(undefined);
    if (!result.available || result.error) {
      setError(result.error ?? "復旧スナップショットを作成できませんでした。");
      return;
    }
    if (result.data) {
      setBackupMessage(`検証済み復旧カタログを ${result.data.path} へ保存しました。SHA-256: ${result.data.sha256}`);
    }
  }

  async function chooseMigrationArchive() {
    setError(undefined);
    setImportPreview(undefined);
    setImportResult(undefined);
    setImporting(true);
    const result = await pickAndroidMigrationArchive();
    setImporting(false);
    if (!result.available || result.error) {
      setError(result.error ?? "ブラウザプレビューでは移行ZIPを確認できません。");
      return;
    }
    if (result.data) setImportPreview(result.data);
  }

  async function commitMigrationArchive() {
    if (!importPreview) return;
    setError(undefined);
    setImporting(true);
    const result = await commitAndroidMigrationArchive(importPreview.token);
    setImporting(false);
    if (!result.available || result.error || !result.data) {
      setError(result.error ?? "移行内容を保存できませんでした。");
      return;
    }
    setImportResult(result.data);
    setImportPreview(undefined);
    onCatalogImported();
  }

  async function exportBackup() {
    setError(undefined);
    setBackupMessage(undefined);
    setBackupBusy(true);
    const result = await exportSettingsBackup();
    setBackupBusy(false);
    if (!result.available || result.error) {
      setError(result.error ?? "設定バックアップを書き出せませんでした。");
      return;
    }
    if (result.data) {
      setBackupMessage(`設定 ${result.data.preferences}件を ${result.data.path} へ保存しました。`);
    }
  }

  async function importBackup() {
    setError(undefined);
    setBackupMessage(undefined);
    setBackupBusy(true);
    const result = await importSettingsBackup();
    if (!result.available || result.error) {
      setBackupBusy(false);
      setError(result.error ?? "設定バックアップを復元できませんでした。");
      return;
    }
    if (result.data) {
      const refreshed = await getPreferences();
      setPreferences(refreshed.data);
      announceThemePreferences(refreshed.data);
      configureNativeNotifications(refreshed.data.nativeNotifications);
      setBackupMessage(`設定 ${result.data.preferences}件を復元しました。`);
      onCatalogImported();
    }
    setBackupBusy(false);
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="PREFERENCES"
        title="設定"
        description="ライブラリー、表示、Android版からのデータ移行を管理します。"
      />
      {!nativeAvailable && <NativePreviewNotice />}
      {error && <StatusPanel tone="error" icon="warning" title="操作を完了できませんでした"><p>{error}</p></StatusPanel>}
      {backupMessage && <StatusPanel tone="success" icon="check" title="操作が完了しました"><p>{backupMessage}</p></StatusPanel>}
      {importResult && (
        <StatusPanel
          tone="success"
          icon="check"
          title={importResult.alreadyImported ? "この移行ZIPは取り込み済みです" : "移行データを取り込みました"}
        >
          {importResult.alreadyImported ? (
            <p>同じSHA-256の移行ZIPがすでに正常完了しているため、データを重複登録しませんでした。</p>
          ) : (
            <p>
              メディア {importResult.importedMedia}件、お気に入り {importResult.importedFavorites}件、
              タグ {importResult.importedTags}件、しおり {importResult.importedBookmarks}件、
              資料 {importResult.importedReferenceProjects}プロジェクト／{importResult.importedReferenceItems}項目、
              X履歴 {importResult.importedXHistory}件を保存しました。
              未照合などでスキップしたメディアは {importResult.skippedMedia}件です。
            </p>
          )}
        </StatusPanel>
      )}

      <div className="settings-layout">
        <section className="panel settings-section" aria-labelledby="library-settings-title">
          <div className="panel-heading">
            <div><p className="kicker">LIBRARY</p><h2 id="library-settings-title">メディアフォルダー</h2></div>
            <button className="secondary-button" type="button" onClick={onAddFolder} disabled={busy || !nativeAvailable}>
              <Icon name="folderPlus" />追加
            </button>
          </div>
          {roots.length === 0 ? (
            <EmptyState icon="folder" title="優先フォルダーはありません" description="Windowsアプリでフォルダーを選択してください。" />
          ) : (
            <div className="folder-list">
              {roots.map((root) => (
                <article key={root.id}>
                  <div className="folder-list-icon"><Icon name="folder" /></div>
                  <div>
                    <strong>{root.displayName}</strong>
                    <span title={root.path}>{root.path}</span>
                    <small>{formatCount(root.mediaCount)}件 · 最終スキャン {formatDate(root.lastScannedAt)}</small>
                  </div>
                  <div>
                    <button type="button" aria-label={`${root.displayName}を再スキャン`} onClick={() => onScan(root.id)} disabled={busy}>
                      <Icon name="refresh" />
                    </button>
                    <button type="button" aria-label={`${root.displayName}の優先指定を解除`} onClick={() => onRemoveRoot(root)} disabled={busy}>
                      <Icon name="trash" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          <p className="section-note">
            優先指定の解除では、ファイル・タグ・お気に入りを保持します。閲覧した場所の監視は継続します。
          </p>
        </section>

        <section className="panel settings-section diagnostics-section" aria-labelledby="diagnostics-title">
          <div className="panel-heading">
            <div><p className="kicker">DIAGNOSTICS & RECOVERY</p><h2 id="diagnostics-title">診断と安全な復旧</h2></div>
            {diagnostics && (
              <span className={`state-chip ${diagnostics.status === "healthy" ? "saved" : "warning"}`}>
                {diagnostics.status === "healthy" ? "正常" : "要確認"}
              </span>
            )}
          </div>
          <p>
            SQLiteの整合性と参照関係を確認します。診断レポートにはメディアのパス、ファイル名、タグ、設定値を含めません。
            復旧スナップショットは使用中のカタログを変更せず、別ファイルとして作成・再検証します。
          </p>
          {diagnostics && (
            <div className="diagnostics-grid">
              <div><span>カタログ</span><strong>{formatBytes(diagnostics.databaseBytes + diagnostics.walBytes)}</strong></div>
              <div><span>優先フォルダー</span><strong>{formatCount(diagnostics.rootCount)}</strong></div>
              <div><span>メディア</span><strong>{formatCount(diagnostics.mediaCount)}</strong></div>
              <div><span>欠損記録</span><strong>{formatCount(diagnostics.missingMediaCount)}</strong></div>
              <div><span>外部キー問題</span><strong>{formatCount(diagnostics.foreignKeyIssues)}</strong></div>
              <div><span>DBスキーマ</span><strong>v{diagnostics.databaseSchemaVersion}</strong></div>
            </div>
          )}
          {diagnostics?.lastCrashDetected && (
            <div className="diagnostics-crash-warning" role="alert">
              <Icon name="warning" />
              <span><strong>前回のネイティブ異常終了を検出しました</strong><small>{diagnostics.lastCrashSummary ?? "診断レポートを書き出して確認してください。"}</small></span>
            </div>
          )}
          {diagnostics?.status === "issues" && (
            <div className="diagnostics-issues" role="alert">
              <strong>自動メンテナンスとスナップショット作成を停止しました</strong>
              <small>{diagnostics.quickCheckMessages.join(" / ")}</small>
            </div>
          )}
          <div className="diagnostics-actions">
            <button className="primary-button" type="button" disabled={Boolean(diagnosticsBusy) || !nativeAvailable} onClick={() => void inspectDiagnostics(false)}>
              <Icon name="database" />{diagnosticsBusy === "inspect" ? "確認中…" : "整合性を確認"}
            </button>
            <button className="secondary-button" type="button" disabled={Boolean(diagnosticsBusy) || !nativeAvailable || diagnostics?.status === "issues"} onClick={() => void inspectDiagnostics(true)}>
              <Icon name="refresh" />{diagnosticsBusy === "optimize" ? "処理中…" : "安全なメンテナンス"}
            </button>
            <button className="secondary-button" type="button" disabled={Boolean(diagnosticsBusy) || !nativeAvailable} onClick={() => void exportDiagnostics()}>
              <Icon name="download" />{diagnosticsBusy === "export" ? "書き出し中…" : "診断レポート"}
            </button>
            <button className="secondary-button" type="button" disabled={Boolean(diagnosticsBusy) || !nativeAvailable || diagnostics?.status === "issues"} onClick={() => void createRecoverySnapshot()}>
              <Icon name="hardDrive" />{diagnosticsBusy === "snapshot" ? "作成中…" : "復旧スナップショット"}
            </button>
          </div>
        </section>

        <section className="panel settings-section" aria-labelledby="display-settings-title">
          <div className="panel-heading">
            <div><p className="kicker">DISPLAY & BEHAVIOR</p><h2 id="display-settings-title">表示と動作</h2></div>
          </div>
          {loading ? <LoadingPanel label="設定を読み込み中…" /> : (
            <div className="preference-list">
              <label>
                <span><strong>表示テーマ</strong><small>Windows設定に追従、または明暗を固定</small></span>
                <SelectMenu
                  value={preferences.theme}
                  disabled={savingKey === "theme"}
                  ariaLabel="表示テーマ"
                  onChange={(value) => void updatePreference("theme", value as UserPreferences["theme"])}
                  options={[
                    { value: "system", label: "システム設定" },
                    { value: "dark", label: "ダーク" },
                    { value: "light", label: "ライト" },
                  ]}
                />
              </label>
              <label>
                <span><strong>カラープリセット</strong><small>Android版と共通の代表配色</small></span>
                <SelectMenu
                  value={preferences.themePalette}
                  disabled={savingKey === "themePalette"}
                  ariaLabel="カラープリセット"
                  onChange={(value) => void updatePreference("themePalette", value as ThemePresetId)}
                  options={[
                    { value: "default", label: "標準" },
                    ...themePresets.map((preset) => ({
                      value: preset.id,
                      label: preset.label,
                      description: preset.id === "paper" || preset.id === "sunrise" || preset.id === "spring" || preset.id === "summer" || preset.id === "sakuraMist" || preset.id === "freshLeaf" || preset.id === "porcelain" || preset.id === "lilac" || preset.id === "aqua" || preset.id === "autumnLeaf"
                        ? "ライト配色"
                        : "ダーク配色",
                    })),
                    { value: "custom", label: "カスタム" },
                  ]}
                />
              </label>
              {preferences.themePalette === "custom" && (
                <div className="theme-color-editor" role="group" aria-label="カスタム配色">
                  {([
                    ["themeBackground", "背景"],
                    ["themeSurface", "カード"],
                    ["themeText", "本文"],
                    ["themeMuted", "補助文字"],
                    ["themeAccent", "アクセント"],
                    ["themeDanger", "エラー"],
                    ["themeSuccess", "成功"],
                    ["themeBorder", "境界線"],
                  ] as const).map(([key, label]) => (
                    <label key={key}>
                      <span>{label}</span>
                      <input
                        type="color"
                        value={preferences[key]}
                        disabled={savingKey === key}
                        aria-label={`${label}の色`}
                        onChange={(event) => void updatePreference(key, event.target.value)}
                      />
                      <code>{preferences[key]}</code>
                    </label>
                  ))}
                </div>
              )}
              <label>
                <span><strong>サムネイルサイズ</strong><small>ギャラリーの既定表示</small></span>
                <SelectMenu
                  value={preferences.thumbnailSize}
                  disabled={savingKey === "thumbnailSize"}
                  ariaLabel="サムネイルサイズ"
                  onChange={(value) => void updatePreference("thumbnailSize", value as UserPreferences["thumbnailSize"])}
                  options={[{ value: "small", label: "小" }, { value: "medium", label: "中" }, { value: "large", label: "大" }]}
                />
              </label>
              <label>
                <span><strong>既定の並び順</strong><small>画面を開いたときの順序</small></span>
                <SelectMenu
                  value={preferences.defaultSort}
                  disabled={savingKey === "defaultSort"}
                  ariaLabel="既定の並び順"
                  onChange={(value) => void updatePreference("defaultSort", value as UserPreferences["defaultSort"])}
                  options={[{ value: "modifiedAt", label: "更新日" }, { value: "importedAt", label: "取り込み日" }, { value: "name", label: "名前" }]}
                />
              </label>
              <label>
                <span><strong>ビュワーの情報表示</strong><small>タグ・詳細・おすすめの表示位置</small></span>
                <SelectMenu
                  value={preferences.viewerInfoLayout}
                  disabled={savingKey === "viewerInfoLayout"}
                  ariaLabel="ビュワーの情報表示"
                  onChange={(value) => void updatePreference("viewerInfoLayout", value as UserPreferences["viewerInfoLayout"])}
                  options={[
                    { value: "top", label: "上" },
                    { value: "bottom", label: "下" },
                    { value: "left", label: "左" },
                    { value: "right", label: "右" },
                    { value: "floating", label: "フローティング" },
                  ]}
                />
              </label>
              <PreferenceSwitch
                label="ごみ箱へ移動する前に確認"
                description="誤操作を防ぐ確認ダイアログを表示"
                checked={preferences.confirmBeforeRecycle}
                disabled={savingKey === "confirmBeforeRecycle"}
                onChange={(value) => void updatePreference("confirmBeforeRecycle", value)}
              />
              <PreferenceSwitch
                label="ファイル変更を自動反映"
                description="優先フォルダーの配下と、閲覧したフォルダーを監視"
                checked={preferences.watchFolders}
                disabled={savingKey === "watchFolders"}
                onChange={(value) => void updatePreference("watchFolders", value)}
              />
              <PreferenceSwitch
                label="新しい画像を自動解析"
                description="監視で追加された画像・GIFを待ち行列へ保存し、ほかのAI分析が終わり次第解析"
                checked={preferences.autoAnalyze}
                disabled={savingKey === "autoAnalyze"}
                onChange={(value) => void updatePreference("autoAnalyze", value)}
              />
              <PreferenceSwitch
                label="Windows通知"
                description="AI分析完了や新しいメディアの追加をWindowsの通知として表示"
                checked={preferences.nativeNotifications}
                disabled={savingKey === "nativeNotifications"}
                onChange={(value) => void updatePreference("nativeNotifications", value)}
              />
              <div className="preference-inline-action">
                <span><strong>通知の動作確認</strong><small>Windowsの集中モード設定が優先されます</small></span>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!nativeAvailable || !preferences.nativeNotifications}
                  onClick={() => void testNativeNotification()}
                >
                  <Icon name="bell" />テスト通知
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="panel settings-section" aria-labelledby="settings-backup-title">
          <div className="panel-heading">
            <div><p className="kicker">SETTINGS BACKUP</p><h2 id="settings-backup-title">設定をバックアップ</h2></div>
          </div>
          <p>
            表示設定、お気に入りサイト／クリエイター、資料プロジェクトなど、Windows版の設定を1つのJSONへ保存・復元します。
            メディア本体、タグ、AI分析結果は含みません。
          </p>
          <div className="settings-backup-actions">
            <button className="primary-button" type="button" disabled={backupBusy || !nativeAvailable} onClick={() => void exportBackup()}>
              <Icon name="download" />{backupBusy ? "処理中…" : "JSONへ書き出す"}
            </button>
            <button className="secondary-button" type="button" disabled={backupBusy || !nativeAvailable} onClick={() => void importBackup()}>
              <Icon name="upload" />JSONから復元
            </button>
          </div>
        </section>

        <section className="panel settings-section migration-section" aria-labelledby="migration-title">
          <div className="panel-heading">
            <div><p className="kicker">ANDROID MIGRATION</p><h2 id="migration-title">Android版データを移行</h2></div>
            <span className="state-chip">形式 v{runtimeInfo.migrationFormatVersion}</span>
          </div>
          <p>
            Android版が出力したチェックサム付きZIPを検証して取り込みます。タグ、お気に入り、設定、しおり、資料、X保存履歴が対象です。
            メディア本体は優先フォルダー内のファイルと照合します。
          </p>
          <ol>
            <li><span>1</span>Android版でWindows移行用データを書き出す</li>
            <li><span>2</span>メディア本体をWindowsの任意フォルダーへコピーする</li>
            <li><span>3</span>そのフォルダーを登録・スキャン後、移行ZIPを選択する</li>
          </ol>
          <button
            className="primary-button"
            type="button"
            onClick={() => void chooseMigrationArchive()}
            disabled={importing || !nativeAvailable}
          >
            <Icon name="upload" />{importing ? "検証中…" : "移行ZIPを選択して検証"}
          </button>

          {importPreview && (
            <div className="migration-preview" role="region" aria-label="移行内容の事前確認">
              <div className="migration-preview-heading">
                <div>
                  <strong>{importPreview.sourceName}</strong>
                  <small>Android {importPreview.androidVersion} · {importPreview.exportedAt}</small>
                </div>
                <span className={`state-chip${importPreview.ambiguousMedia + importPreview.missingMedia > 0 ? " warning" : ""}`}>
                  {importPreview.alreadyImported ? "取り込み済み" : "検証済み"}
                </span>
              </div>
              <dl className="migration-preview-counts">
                <div><dt>メディア</dt><dd>{importPreview.totalMedia}件</dd></div>
                <div><dt>一致</dt><dd>{importPreview.matchedMedia}件</dd></div>
                <div><dt>曖昧</dt><dd>{importPreview.ambiguousMedia}件</dd></div>
                <div><dt>未検出</dt><dd>{importPreview.missingMedia}件</dd></div>
                <div><dt>タグ</dt><dd>{importPreview.tagRecords}件</dd></div>
                <div><dt>しおり</dt><dd>{importPreview.matchedBookmarks}/{importPreview.bookmarkRecords}件</dd></div>
                <div><dt>資料</dt><dd>{importPreview.referenceRecords}件</dd></div>
                <div><dt>X履歴</dt><dd>{importPreview.xHistoryRecords}件</dd></div>
              </dl>
              {importPreview.issueCount > 0 && (
                <div className="migration-issues">
                  <strong>自動取り込みしない項目: {importPreview.issueCount}件</strong>
                  <p>候補が複数ある項目は勝手に割り当てず、今回の確定対象から外します。</p>
                  <ul>
                    {importPreview.issues.map((issue, index) => (
                      <li key={`${issue.sourceIdentity}-${index}`}>{issue.message}</li>
                    ))}
                  </ul>
                  {importPreview.issueCount > importPreview.issues.length && (
                    <small>ほか {importPreview.issueCount - importPreview.issues.length}件</small>
                  )}
                </div>
              )}
              <div className="migration-preview-actions">
                <button
                  className="primary-button"
                  type="button"
                  disabled={importing}
                  onClick={() => void commitMigrationArchive()}
                >
                  <Icon name="check" />
                  {importPreview.alreadyImported ? "取り込み済みを確認" : "一致したデータを取り込む"}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={importing}
                  onClick={() => setImportPreview(undefined)}
                >
                  キャンセル
                </button>
              </div>
              <small className="migration-sha">SHA-256: {importPreview.sourceSha256}</small>
            </div>
          )}
        </section>

        <section className="panel settings-section about-section" aria-labelledby="about-title">
          <div className="panel-heading">
            <div><p className="kicker">ABOUT</p><h2 id="about-title">アプリ情報</h2></div>
          </div>
          <dl>
            <div><dt>アプリ</dt><dd>{runtimeInfo.appName}</dd></div>
            <div><dt>バージョン</dt><dd>{runtimeInfo.appVersion}</dd></div>
            <div><dt>環境</dt><dd>{runtimeInfo.os} · {runtimeInfo.arch}</dd></div>
            <div><dt>データベース</dt><dd>スキーマ v{runtimeInfo.databaseSchemaVersion}</dd></div>
            <div>
              <dt>自動更新</dt>
              <dd>
                <span className={`state-chip ${runtimeInfo.automaticUpdatesEnabled ? "saved" : "warning"}`}>
                  {runtimeInfo.automaticUpdatesEnabled ? "署名検証を有効化" : "安全のため無効"}
                </span>
              </dd>
            </div>
          </dl>
          {!runtimeInfo.automaticUpdatesEnabled && (
            <div className="update-readiness" role="note" aria-label="自動更新の構成状況">
              <strong>署名付き自動更新の配布準備</strong>
              <ul>
                <li className={runtimeInfo.updateHttpsEndpointConfigured ? "ready" : "pending"}>HTTPS更新先</li>
                <li className={runtimeInfo.updatePublicKeyConfigured ? "ready" : "pending"}>更新署名の公開鍵</li>
                <li className={runtimeInfo.windowsSigningCertificateConfigured ? "ready" : "pending"}>Windowsコード署名証明書</li>
              </ul>
              <small>未構成の配布物を受け入れるフォールバックは実装していません。</small>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function PreferenceSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="switch-row">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch-control" aria-hidden="true"><span /></span>
    </label>
  );
}
