import { useRef, useState } from "react";
import { createCatalogRecoverySnapshot, exportDiagnosticsReport, getSystemDiagnostics, optimizeCatalog, type RecoverySnapshotResult, type SystemDiagnostics } from "../services/native";
import { Icon } from "./Icon";
import { formatBytes } from "./Ui";
import "./GeneralSettings.css";

type DiagnosticAction = "inspect" | "optimize" | "export" | "snapshot";

export function DiagnosticSettings({ nativeAvailable }: { nativeAvailable: boolean }) {
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics>();
  const [snapshot, setSnapshot] = useState<RecoverySnapshotResult>();
  const [busy, setBusy] = useState<DiagnosticAction>();
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  async function runDiagnostic(action: DiagnosticAction) {
    if (!nativeAvailable || busyRef.current) return;
    if ((action === "optimize" || action === "snapshot") && diagnostics?.status !== "healthy") {
      setError("先に整合性を確認してください。問題がある状態ではメンテナンスやスナップショット作成を実行できません。");
      return;
    }
    busyRef.current = true;
    setBusy(action);
    setError(undefined);
    setMessage(undefined);
    try {
      if (action === "inspect" || action === "optimize") {
        const result = action === "inspect" ? await getSystemDiagnostics() : await optimizeCatalog();
        if (!result.available || result.error) throw new Error(result.error ?? "カタログ診断を実行できませんでした。");
        setDiagnostics(result.data);
        setMessage(result.data.status === "healthy"
          ? action === "inspect" ? "カタログの整合性に問題は見つかりませんでした。" : "カタログメンテナンスが終了しました。"
          : "カタログに確認が必要な問題があります。診断レポートを保存してください。");
      } else if (action === "export") {
        const result = await exportDiagnosticsReport();
        if (!result.available || result.error) throw new Error(result.error ?? "診断レポートを書き出せませんでした。");
        if (result.data) setMessage(`診断レポートを ${result.data.path} へ保存しました（${formatBytes(result.data.bytes)}）。`);
      } else {
        const result = await createCatalogRecoverySnapshot();
        if (!result.available || result.error) throw new Error(result.error ?? "復旧スナップショットを作成できませんでした。");
        if (result.data) {
          setSnapshot(result.data);
          setMessage("カタログを変更せず、復旧用コピーを別ファイルへ作成・検証しました。");
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // A failed maintenance/inspection may invalidate the last healthy result.
      if (action === "inspect" || action === "optimize" || action === "snapshot") setDiagnostics(undefined);
    } finally { busyRef.current = false; setBusy(undefined); }
  }

  const disabled = Boolean(busy) || !nativeAvailable;
  const unsafe = diagnostics?.status !== "healthy";
  return <section className="settings-panel diagnostic-settings" aria-labelledby="diagnostics-title" aria-busy={Boolean(busy)}>
    <div className="section-heading"><div><h2 id="diagnostics-title">診断と復旧用コピー</h2></div>
      {diagnostics && <span className={`state-chip${diagnostics.status === "healthy" ? " saved" : " warning"}`}>{diagnostics.status === "healthy" ? "正常" : "要確認"}</span>}
    </div>
    <p className="muted-copy">カタログの整合性と参照関係を確認します。診断レポートにはメディアのパス・名前・タグ・設定値を含めません。復旧用コピーは現在のカタログを書き換えません。</p>
    {(error || message) && <p className={`operation-message${error ? " error" : ""}`} role={error ? "alert" : "status"}>{error ?? message}</p>}
    {diagnostics && <div className="diagnostics-grid">
      {([
        ["カタログ容量", formatBytes(diagnostics.databaseBytes + diagnostics.walBytes)],
        ["登録済みルート", diagnostics.rootCount.toLocaleString("ja-JP")],
        ["メディア", diagnostics.mediaCount.toLocaleString("ja-JP")],
        ["欠損記録", diagnostics.missingMediaCount.toLocaleString("ja-JP")],
        ["外部キー問題", diagnostics.foreignKeyIssues.toLocaleString("ja-JP")],
        ["DBスキーマ", `v${diagnostics.databaseSchemaVersion}`],
      ] as const).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div>}
    {diagnostics?.lastCrashDetected && <div className="diagnostics-crash-warning" role="alert"><Icon name="warning" />
      <span><strong>前回の異常終了を検出しました</strong><small>{diagnostics.lastCrashSummary ?? "診断レポートを保存して内容を確認してください。"}</small></span>
    </div>}
    {diagnostics?.status === "issues" && <div className="diagnostics-issues" role="alert"><strong>メンテナンスとスナップショット作成を停止しています</strong>
      <small>{diagnostics.quickCheckMessages.join(" / ") || `外部キー問題: ${diagnostics.foreignKeyIssues}件`}</small>
    </div>}
    {!diagnostics && <p className="muted-copy">まず「整合性を確認」を実行してください。確認前はメンテナンスと復旧用コピーを実行できません。</p>}
    <div className="diagnostics-actions">
      <button type="button" className="primary-button" disabled={disabled} onClick={() => void runDiagnostic("inspect")}><Icon name="database" />{busy === "inspect" ? "確認中…" : "整合性を確認"}</button>
      <button type="button" className="secondary-button" disabled={disabled || unsafe} onClick={() => void runDiagnostic("optimize")}><Icon name="refresh" />{busy === "optimize" ? "処理中…" : "安全なメンテナンス"}</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => void runDiagnostic("export")}><Icon name="download" />{busy === "export" ? "保存中…" : "診断レポート"}</button>
      <button type="button" className="secondary-button" disabled={disabled || unsafe} onClick={() => void runDiagnostic("snapshot")}><Icon name="hardDrive" />{busy === "snapshot" ? "作成中…" : "復旧スナップショット"}</button>
    </div>
    {snapshot && <dl className="diagnostics-snapshot"><dt>復旧用コピー</dt><dd>{snapshot.path}（{formatBytes(snapshot.bytes)}）</dd><dt>SHA-256</dt><dd>{snapshot.sha256}</dd></dl>}
  </section>;
}
