import { useMemo, useState } from "react";

import { useOperations } from "../hooks/useOperations";
import { cancelAiAnalysis } from "../services/ai";
import { localAssetUrl } from "../services/native";
import { dismissOperation, type OperationItem } from "../services/operations";
import { Icon, type IconName } from "./Icon";
import "./OperationTray.css";

function statusIcon(operation: OperationItem): IconName {
  if (operation.status === "success") return "check";
  if (operation.status === "error") return "warning";
  if (operation.status === "cancelled") return "info";
  return "refresh";
}

function statusText(operation: OperationItem): string {
  if (operation.status === "success") return "完了";
  if (operation.status === "error") return "失敗";
  if (operation.status === "cancelled") return "キャンセル";
  return "実行中";
}

export function OperationTray() {
  const operations = useOperations();
  const [minimized, setMinimized] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  const visibleOperations = operations.filter((operation) => !hiddenIds.has(operation.id));
  const runningCount = visibleOperations.filter((operation) => operation.status === "running").length;
  const announcement = useMemo(
    () =>
      visibleOperations
        .map((operation) => `${operation.label}、${statusText(operation)}`)
        .join("。"),
    [visibleOperations],
  );

  async function stopAiOperation(operation: OperationItem) {
    if (!operation.id.startsWith("ai-analysis:") || cancellingIds.has(operation.id)) return;
    const jobId = operation.id.slice("ai-analysis:".length);
    setCancellingIds((current) => new Set(current).add(operation.id));
    try {
      await cancelAiAnalysis(jobId || undefined);
    } finally {
      setCancellingIds((current) => {
        const next = new Set(current);
        next.delete(operation.id);
        return next;
      });
    }
  }

  function hideOperation(operationId: string) {
    setHiddenIds((current) => new Set(current).add(operationId));
  }

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {visibleOperations.length > 0 && (
        <aside className={`operation-tray${minimized ? " is-minimized" : ""}`} aria-label="バックグラウンド処理">
          {minimized ? (
            <button
              type="button"
              className="operation-tray-restore"
              aria-label="進捗ポップアップを開く"
              title="進捗を表示"
              onClick={() => setMinimized(false)}
            >
              <span><Icon name={runningCount > 0 ? "refresh" : "check"} className={runningCount > 0 ? "is-spinning" : undefined} /></span>
              <strong>{runningCount > 0 ? `${runningCount}件を処理中` : `${visibleOperations.length}件の結果`}</strong>
            </button>
          ) : (
            <>
              <div className="operation-tray-toolbar">
                <span><Icon name="sparkles" />バックグラウンド処理</span>
                <button
                  type="button"
                  aria-label="進捗ポップアップを最小化"
                  title="最小化"
                  onClick={() => setMinimized(true)}
                >
                  <Icon name="minus" />
                </button>
              </div>
              <div className="operation-tray-list">
            {visibleOperations.map((operation) => {
              const determinate =
                operation.status === "running" && operation.progress !== null;
              const previewSource = localAssetUrl(operation.previewPath);
              return (
                <article
                  className={`operation-card is-${operation.status}`}
                  key={operation.id}
                >
                  <div className={`operation-card-icon${previewSource ? " has-preview" : ""}`} aria-hidden="true">
                    {previewSource ? (
                      <img src={previewSource} alt="" decoding="async" />
                    ) : (
                      <Icon
                        name={statusIcon(operation)}
                        className={operation.status === "running" ? "is-spinning" : undefined}
                      />
                    )}
                  </div>
                  <div className="operation-card-content">
                    <div className="operation-card-heading">
                      <strong>{operation.label}</strong>
                      <span>
                        {determinate ? `${Math.round(operation.progress ?? 0)}% · ` : ""}
                        {statusText(operation)}
                      </span>
                    </div>
                    {operation.detail && (
                      <p title={operation.detail}>{operation.detail}</p>
                    )}
                    {operation.status === "running" && (
                      <div
                        className={`operation-card-progress ${
                          determinate ? "" : "is-indeterminate"
                        }`}
                        role="progressbar"
                        aria-label={`${operation.label}の進捗`}
                        aria-valuemin={determinate ? 0 : undefined}
                        aria-valuemax={determinate ? 100 : undefined}
                        aria-valuenow={
                          determinate ? Math.round(operation.progress ?? 0) : undefined
                        }
                      >
                        <span
                          style={
                            determinate
                              ? { width: `${operation.progress ?? 0}%` }
                              : undefined
                          }
                        />
                      </div>
                    )}
                  </div>
                  {operation.status === "running" && operation.id.startsWith("ai-analysis:") && (
                    <div className="operation-card-running-actions">
                      <button
                        type="button"
                        disabled={cancellingIds.has(operation.id)}
                        aria-label={`${operation.label}を停止`}
                        title="停止"
                        onClick={() => void stopAiOperation(operation)}
                      >
                        <Icon name="stop" />
                        <span>{cancellingIds.has(operation.id) ? "停止中" : "停止"}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`${operation.label}の進捗表示を閉じる`}
                        title="進捗表示を閉じる"
                        onClick={() => hideOperation(operation.id)}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                  )}
                  {operation.status !== "running" && (
                    <button
                      className="operation-card-dismiss"
                      type="button"
                      aria-label={`${operation.label}を閉じる`}
                      onClick={() => dismissOperation(operation.id)}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </article>
              );
            })}
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}

export default OperationTray;
