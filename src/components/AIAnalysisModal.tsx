import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import {
  cancelAiAnalysis,
  getAiAnalysisStatus,
  getAiModelStatus,
  isAiAnalysisActive,
  listenToAiAnalysis,
  previewAiAnalysisScope,
  setAiAnalysisPaused,
  startAiAnalysis,
  type AiAnalysisLevel,
  type AiAnalysisProgress,
  type AiAnalysisScope,
  type AiModelStatus,
} from "../services/ai";
import {
  listLibraryRoots,
  listMediaFolders,
  localAssetUrl,
  type LibraryRoot,
  type MediaFolder,
  type MediaItem,
} from "../services/native";
import { useTagTranslations } from "../services/tagTranslations";
import { useAppBack } from "../hooks/useAppBack";
import { useFloatingPanel } from "../hooks/useFloatingPanel";
import { Icon } from "./Icon";
import { SelectMenu } from "./Ui";
import "./AIAnalysisModal.css";

export type AIAnalysisModalProps = {
  open: boolean;
  selectedItems: Array<Pick<MediaItem, "id" | "name" | "kind">>;
  initialRootId?: string;
  initialFolderPath?: string;
  currentFolderOnly?: boolean;
  floating?: boolean;
  onClose: () => void;
  onCompleted?: (progress: AiAnalysisProgress) => void | Promise<void>;
};

const terminalPhases = new Set(["completed", "cancelled", "failed"]);
type AnalysisPeriod = "all" | "7days" | "30days" | "90days" | "year" | "custom";
const categoryLabels: Record<string, string> = {
  general: "一般",
  character: "キャラクター",
  copyright: "作品",
  artist: "作者",
  meta: "メタ",
  other: "その他",
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "AI分析中に予期しないエラーが発生しました";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function progressPercent(progress?: AiAnalysisProgress): number {
  if (!progress) return 0;
  if (
    (progress.phase === "downloading" || progress.phase === "verifying") &&
    progress.downloadTotalBytes > 0
  ) {
    return Math.min(
      100,
      Math.round((progress.downloadedBytes / progress.downloadTotalBytes) * 100),
    );
  }
  if (progress.phase === "completed") return 100;
  if (progress.totalItems <= 0) return 0;
  const completed = Math.max(
    progress.analyzedItems + progress.failedItems + progress.skippedItems,
    progress.currentItem - 1,
  );
  return Math.min(99, Math.round((completed / progress.totalItems) * 100));
}

function customDateMillis(value: string): number | undefined {
  if (!value) return undefined;
  const millis = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(millis) ? millis : undefined;
}

function normalizeFolderPath(value: string | undefined): string {
  return (value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function scopeForPeriod(
  period: AnalysisPeriod,
  rootId: string,
  folderPath: string,
  includeSubfolders: boolean,
  directRootOnly: boolean,
  customFrom: string,
  customTo: string,
): AiAnalysisScope | undefined {
  const now = new Date();
  let modifiedFrom: number | undefined;
  let modifiedBefore: number | undefined;
  if (period === "7days" || period === "30days" || period === "90days") {
    const days = period === "7days" ? 7 : period === "30days" ? 30 : 90;
    modifiedFrom = now.getTime() - days * 24 * 60 * 60 * 1000;
  } else if (period === "year") {
    modifiedFrom = new Date(now.getFullYear(), 0, 1).getTime();
  } else if (period === "custom") {
    modifiedFrom = customDateMillis(customFrom);
    const endStart = customDateMillis(customTo);
    if (modifiedFrom === undefined || endStart === undefined) return undefined;
    const endDate = new Date(endStart);
    endDate.setDate(endDate.getDate() + 1);
    modifiedBefore = endDate.getTime();
    if (modifiedFrom >= modifiedBefore) return undefined;
  }
  return {
    rootId: rootId || undefined,
    // An empty path deliberately means files directly under the registered root.
    folderPath: rootId && (folderPath || directRootOnly) ? folderPath : undefined,
    includeSubfolders,
    modifiedFrom,
    modifiedBefore,
  };
}

export function AIAnalysisModal({
  open,
  selectedItems: _selectedItems,
  initialRootId,
  initialFolderPath,
  currentFolderOnly = false,
  floating = false,
  onClose,
  onCompleted,
}: AIAnalysisModalProps) {
  const translateTag = useTagTranslations();
  const [model, setModel] = useState<AiModelStatus>();
  const [progress, setProgress] = useState<AiAnalysisProgress>();
  const [starting, setStarting] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const [error, setError] = useState<string>();
  const [analysisLevel, setAnalysisLevel] =
    useState<AiAnalysisLevel>("standard");
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const initialNormalizedFolder = initialRootId
    ? normalizeFolderPath(initialFolderPath)
    : "";
  const [rootId, setRootId] = useState(initialRootId ?? "");
  const [folderPath, setFolderPath] = useState(initialNormalizedFolder);
  const [folderCursor, setFolderCursor] = useState(initialNormalizedFolder);
  const [includeSubfolders, setIncludeSubfolders] = useState(!currentFolderOnly);
  const [period, setPeriod] = useState<AnalysisPeriod>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [scopeCount, setScopeCount] = useState<number>();
  const [scopeLoading, setScopeLoading] = useState(false);
  const completedJobRef = useRef<string | undefined>(undefined);
  const cancelledJobRef = useRef<{ jobId?: string } | undefined>(undefined);
  const observedActiveJobRef = useRef<string | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  const { panelRef, floatingStyle, onDragPointerDown } = useFloatingPanel<HTMLElement>({
    storageKey: "pixvault-ai-background-position",
  });

  const active = progress ? isAiAnalysisActive(progress.phase) : false;
  const percent = progressPercent(progress);
  useAppBack(open, () => {
    if (!starting) onClose();
  });
  const analysisScope = useMemo(
    () =>
      scopeForPeriod(
        period,
        rootId,
        folderPath,
        includeSubfolders,
        currentFolderOnly,
        customFrom,
        customTo,
      ),
    [customFrom, customTo, currentFolderOnly, folderPath, includeSubfolders, period, rootId],
  );
  const analysisTargetLabel = useMemo(() => {
    const rootName = roots.find((root) => root.id === rootId)?.displayName;
    if (!rootId) return "すべてのファイル";
    if (!folderPath) return rootName ?? "登録フォルダー直下";
    return rootName ? `${rootName} / ${folderPath}` : folderPath;
  }, [folderPath, rootId, roots]);
  const folderHierarchy = useMemo(() => {
    const counts = new Map<string, { direct: number; descendants: number }>();
    for (const folder of folders) {
      if (!folder.relativeFolder) continue;
      const segments = folder.relativeFolder.split("/").filter(Boolean);
      for (let index = 1; index <= segments.length; index += 1) {
        const path = segments.slice(0, index).join("/");
        const current = counts.get(path) ?? { direct: 0, descendants: 0 };
        current.descendants += folder.itemCount;
        if (index === segments.length) current.direct += folder.itemCount;
        counts.set(path, current);
      }
    }
    return counts;
  }, [folders]);
  const folderChildren = useMemo(() => {
    const prefix = folderCursor ? `${folderCursor}/` : "";
    return [...folderHierarchy.entries()]
      .filter(([path]) => {
        if (!path.startsWith(prefix) || path === folderCursor) return false;
        return !path.slice(prefix.length).includes("/");
      })
      .sort(([left], [right]) => left.localeCompare(right, "ja"))
      .map(([path, count]) => ({
        path,
        name: path.slice(prefix.length),
        direct: count.direct,
        descendants: count.descendants,
        hasChildren: [...folderHierarchy.keys()].some((candidate) =>
          candidate.startsWith(`${path}/`)),
      }));
  }, [folderCursor, folderHierarchy]);
  const folderCursorSegments = folderCursor.split("/").filter(Boolean);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || active) return;
    const nextRootId = initialRootId ?? "";
    const nextFolderPath = nextRootId
      ? normalizeFolderPath(initialFolderPath)
      : "";
    setRootId(nextRootId);
    setFolderPath(nextFolderPath);
    setFolderCursor(nextFolderPath);
    if (currentFolderOnly) setIncludeSubfolders(false);
  }, [active, currentFolderOnly, initialFolderPath, initialRootId, open]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let removeListener: (() => void) | undefined;

    const receiveProgress = (next: AiAnalysisProgress) => {
      if (disposed) return;
      if (next.jobId && isAiAnalysisActive(next.phase)) {
        observedActiveJobRef.current = next.jobId;
      }
      const cancelledJob = cancelledJobRef.current;
      const belongsToCancelledJob =
        cancelledJob &&
        (!cancelledJob.jobId || cancelledJob.jobId === next.jobId);
      if (belongsToCancelledJob && isAiAnalysisActive(next.phase)) {
        return;
      }
      setProgress(next);
      if (
        belongsToCancelledJob &&
        terminalPhases.has(next.phase) &&
        !next.cleanupPending
      ) {
        cancelledJobRef.current = undefined;
      }
      if (next.phase !== "idle" && next.analysisLevel) {
        setAnalysisLevel(next.analysisLevel);
      }
      setError(next.error);
      if (
        terminalPhases.has(next.phase) &&
        next.jobId &&
        completedJobRef.current !== next.jobId
      ) {
        completedJobRef.current = next.jobId;
        void onCompleted?.(next);
      }
      if (
        next.jobId
        && terminalPhases.has(next.phase)
        && observedActiveJobRef.current === next.jobId
      ) {
        observedActiveJobRef.current = undefined;
        queueMicrotask(() => onCloseRef.current());
      }
    };

    void listenToAiAnalysis(receiveProgress)
      .then((unlisten) => {
        if (disposed) unlisten();
        else removeListener = unlisten;
      })
      .catch((listenError) => {
        if (!disposed) setError(errorText(listenError));
      });
    void Promise.all([getAiModelStatus(), getAiAnalysisStatus()])
      .then(([nextModel, nextProgress]) => {
        if (disposed) return;
        setModel(nextModel);
        receiveProgress(nextProgress);
      })
      .catch((statusError) => {
        if (!disposed) setError(errorText(statusError));
      });

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [open, onCompleted]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void listLibraryRoots()
      .then((result) => {
        if (disposed) return;
        setRoots(result.data);
        if (result.error) setError(result.error);
      })
      .catch((rootError) => {
        if (!disposed) setError(errorText(rootError));
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !rootId) {
      setFolders([]);
      setFolderPath("");
      setFolderCursor("");
      return;
    }
    let disposed = false;
    void listMediaFolders(rootId)
      .then((result) => {
        if (disposed) return;
        setFolders(result.data);
        if (result.error) setError(result.error);
      })
      .catch((folderError) => {
        if (!disposed) setError(errorText(folderError));
      });
    return () => {
      disposed = true;
    };
  }, [open, rootId]);

  useEffect(() => {
    if (!open) return;
    if (!analysisScope) {
      setScopeCount(undefined);
      setScopeLoading(false);
      return;
    }
    let disposed = false;
    setScopeCount(undefined);
    setScopeLoading(true);
    const timer = window.setTimeout(() => {
      void previewAiAnalysisScope(analysisScope)
        .then((preview) => {
          if (!disposed) setScopeCount(preview.analyzableItems);
        })
        .catch((previewError) => {
          if (!disposed) {
            setScopeCount(undefined);
            setError(errorText(previewError));
          }
        })
        .finally(() => {
          if (!disposed) setScopeLoading(false);
        });
    }, 180);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [analysisScope, open]);

  if (!open) return null;

  const handleStart = async () => {
    if (
      !analysisScope ||
      !scopeCount ||
      active ||
      progress?.cleanupPending ||
      starting
    ) {
      return;
    }
    setStarting(true);
    setError(undefined);
    completedJobRef.current = undefined;
    cancelledJobRef.current = undefined;
    try {
      const job = await startAiAnalysis(
        undefined,
        analysisLevel,
        analysisScope,
        scopeCount,
      );
      window.dispatchEvent(new CustomEvent("pixvault:ai-analysis-started", {
        detail: { jobId: job.jobId, targetLabel: analysisTargetLabel },
      }));
      setProgress((current) => ({
        jobId: job.jobId,
        phase: "queued",
        message: "AI分析を準備しています",
        currentItem: 0,
        totalItems: job.totalItems,
        downloadedBytes: current?.downloadedBytes ?? 0,
        downloadTotalBytes:
          current?.downloadTotalBytes ?? model?.totalDownloadBytes ?? 0,
        analyzedItems: 0,
        failedItems: 0,
        skippedItems: job.skippedItems,
        analysisLevel: job.analysisLevel,
        detectedTags: 0,
        categoryCounts: [],
        previewTags: [],
        cleanupPending: false,
      }));
      onClose();
    } catch (startError) {
      setError(errorText(startError));
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!active || cancelPending) return;
    const jobId = progress?.jobId;
    cancelledJobRef.current = { jobId };
    setCancelPending(true);
    setError(undefined);
    setProgress((current) =>
      current
        ? {
            ...current,
            phase: "cancelled",
            message: "AI分析をキャンセルしました",
            currentName: undefined,
            currentPath: undefined,
            cleanupPending: true,
          }
        : current,
    );
    try {
      const cancelled = await cancelAiAnalysis(jobId);
      if (!cancelled) {
        cancelledJobRef.current = undefined;
        const latest = await getAiAnalysisStatus();
        setProgress(latest);
        if (isAiAnalysisActive(latest.phase)) {
          setError("実行中のAI分析を確認できませんでした。もう一度キャンセルしてください。");
        }
      }
    } catch (cancelError) {
      cancelledJobRef.current = undefined;
      setError(errorText(cancelError));
      try {
        setProgress(await getAiAnalysisStatus());
      } catch {
        // Preserve the direct cancellation error when status recovery also fails.
      }
    } finally {
      setCancelPending(false);
    }
  };

  const handlePauseToggle = async () => {
    if (!active || pausePending || !progress?.jobId) return;
    const pause = progress.phase !== "paused";
    setPausePending(true);
    setError(undefined);
    try {
      const changed = await setAiAnalysisPaused(pause, progress.jobId);
      if (!changed) setError("AI分析の一時停止状態を変更できませんでした。");
    } catch (pauseError) {
      setError(errorText(pauseError));
    } finally {
      setPausePending(false);
    }
  };

  const canClose = !starting;
  const statusTone =
    progress?.phase === "failed"
      ? "error"
      : progress?.phase === "cancelled"
        ? "cancelled"
      : progress?.phase === "completed"
        ? "success"
        : "neutral";

  return (
    <div
      className={`ai-analysis-backdrop${floating ? " is-floating" : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (!floating && event.currentTarget === event.target && canClose) onClose();
      }}
    >
      <section
        ref={panelRef}
        className="ai-analysis-modal"
        style={floating ? floatingStyle : undefined}
        role="dialog"
        aria-modal={!active}
        aria-labelledby="ai-analysis-title"
      >
        <header
          className="ai-analysis-header"
          onPointerDown={floating ? onDragPointerDown : undefined}
        >
          <div className="ai-analysis-title-block">
            <span className="ai-analysis-spark" aria-hidden="true">
              ✦
            </span>
            <div>
              <p className="ai-analysis-eyebrow">BACKGROUND PROCESS</p>
              <h2 id="ai-analysis-title">AI・ベクトル分析</h2>
            </div>
          </div>
        </header>

        <div className="ai-analysis-body">
          <div className="ai-analysis-selection" aria-live="polite">
            <div>
              <strong>
                {scopeLoading ? "確認中…" : `${(scopeCount ?? 0).toLocaleString("ja-JP")}件`}
              </strong>
              <span>の画像・GIFが対象</span>
            </div>
            <p>
              {!scopeLoading && analysisScope && scopeCount === 0
                ? "条件に合う画像・GIFがありません。期間かフォルダーを変更してください。"
                : "期間・登録フォルダー・サブフォルダーを組み合わせて絞り込めます。動画とブックは含まれません。"}
            </p>
          </div>

          <section className="ai-analysis-scope-card" aria-labelledby="ai-analysis-scope-title">
            <div className="ai-analysis-scope-heading">
              <div>
                <strong id="ai-analysis-scope-title">分析する範囲</strong>
                <span>期間はファイル更新日を基準に、カタログから対象だけを抽出します</span>
              </div>
              <span className={scopeLoading ? "is-loading" : ""}>
                {scopeLoading ? "件数を確認中" : "対象確定"}
              </span>
            </div>
            <div className="ai-analysis-scope-grid">
              <SelectMenu
                label="期間"
                value={period}
                disabled={active || starting}
                onChange={(value) => setPeriod(value as AnalysisPeriod)}
                options={[
                  { value: "all", label: "全期間" },
                  { value: "7days", label: "直近7日" },
                  { value: "30days", label: "直近30日" },
                  { value: "90days", label: "直近90日" },
                  { value: "year", label: "今年" },
                  { value: "custom", label: "カスタム" },
                ]}
              />
              <SelectMenu
                label="登録フォルダー"
                value={rootId}
                disabled={active || starting || currentFolderOnly}
                onChange={(value) => {
                  setRootId(value);
                  setFolderPath("");
                  setFolderCursor("");
                }}
                options={[
                  { value: "", label: "すべての登録フォルダー" },
                  ...roots.map((root) => ({
                    value: root.id,
                    label: root.displayName,
                    description: root.path,
                  })),
                ]}
              />
              <div className={`ai-analysis-folder-tree${!rootId ? " is-disabled" : ""}${currentFolderOnly ? " is-locked" : ""}`}>
                <div className="ai-analysis-folder-tree-label">
                  <span>サブフォルダー</span>
                  <small>{folderPath
                    ? `選択: ${folderPath}`
                    : currentFolderOnly && rootId
                      ? "選択: ルート直下"
                      : rootId
                        ? "登録フォルダー全体"
                        : "先に登録フォルダーを選択"}</small>
                </div>
                {rootId && (
                  <>
                    <nav className="ai-analysis-folder-breadcrumbs" aria-label="AI分析フォルダー階層">
                      <button
                        type="button"
                        className={!folderCursor ? "is-current" : undefined}
                        disabled={active || starting || currentFolderOnly}
                        onClick={() => {
                          setFolderCursor("");
                          setFolderPath("");
                        }}
                      >
                        <Icon name="hardDrive" />
                        {roots.find((root) => root.id === rootId)?.displayName ?? "登録フォルダー"}
                      </button>
                      {folderCursorSegments.map((segment, index) => {
                        const path = folderCursorSegments.slice(0, index + 1).join("/");
                        return (
                          <span key={path}>
                            <Icon name="chevronRight" />
                            <button
                              type="button"
                              className={path === folderCursor ? "is-current" : undefined}
                              disabled={active || starting || currentFolderOnly}
                              onClick={() => {
                                setFolderCursor(path);
                                setFolderPath(path);
                              }}
                            >
                              {segment}
                            </button>
                          </span>
                        );
                      })}
                    </nav>
                    <div className="ai-analysis-folder-choices">
                      <button
                        type="button"
                        className={folderPath === folderCursor ? "is-selected" : undefined}
                        disabled={active || starting || currentFolderOnly}
                        onClick={() => setFolderPath(folderCursor)}
                      >
                        <span className="ai-analysis-folder-choice-icon"><Icon name="check" /></span>
                        <span>
                          <strong>この階層を選択</strong>
                          <small>{folderCursor || "登録フォルダー全体"}</small>
                        </span>
                      </button>
                      {folderChildren.map((folder) => (
                        <button
                          type="button"
                          key={folder.path}
                          disabled={active || starting || currentFolderOnly}
                          onClick={() => {
                            setFolderCursor(folder.path);
                            setFolderPath(folder.path);
                          }}
                        >
                          <span className="ai-analysis-folder-choice-icon"><Icon name="folder" /></span>
                          <span>
                            <strong>{folder.name}</strong>
                            <small>
                              配下 {folder.descendants.toLocaleString("ja-JP")}件
                              {folder.direct !== folder.descendants
                                ? ` · 直下 ${folder.direct.toLocaleString("ja-JP")}件`
                                : ""}
                            </small>
                          </span>
                          {folder.hasChildren && <Icon name="chevronRight" />}
                        </button>
                      ))}
                      {folderChildren.length === 0 && (
                        <p>この階層にサブフォルダーはありません。</p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
            {period === "custom" && (
              <div className="ai-analysis-date-range">
                <label>
                  <span>開始日</span>
                  <input
                    type="date"
                    value={customFrom}
                    disabled={active || starting}
                    max={customTo || undefined}
                    onChange={(event) => setCustomFrom(event.target.value)}
                  />
                </label>
                <span aria-hidden="true">→</span>
                <label>
                  <span>終了日</span>
                  <input
                    type="date"
                    value={customTo}
                    disabled={active || starting}
                    min={customFrom || undefined}
                    onChange={(event) => setCustomTo(event.target.value)}
                  />
                </label>
                {!analysisScope && (
                  <small>開始日と終了日を正しい順序で指定してください。</small>
                )}
              </div>
            )}
            <label
              className={`ai-analysis-subfolder-toggle ${
                folderPath ? "" : "is-disabled"
              }`}
            >
              <input
                type="checkbox"
                checked={includeSubfolders}
                disabled={currentFolderOnly || !folderPath || active || starting}
                onChange={(event) => setIncludeSubfolders(event.target.checked)}
              />
              <span aria-hidden="true" />
              選択したフォルダーの下位フォルダーも含める
              {currentFolderOnly && <small>現在の階層直下だけを分析します</small>}
            </label>
          </section>

          <fieldset
            className="ai-analysis-levels"
            disabled={active || starting}
          >
            <legend>分析レベル</legend>
            <label
              className={`ai-analysis-level ${
                analysisLevel === "standard" ? "is-selected" : ""
              }`}
            >
              <input
                type="radio"
                name="ai-analysis-level"
                value="standard"
                checked={analysisLevel === "standard"}
                onChange={() => setAnalysisLevel("standard")}
              />
              <span className="ai-analysis-level-copy">
                <strong>標準</strong>
                <span>高速・厳選タグ</span>
                <small>
                  信頼度60%以上、最大40件。いままでの分析結果と同じ設定です。
                </small>
              </span>
              <span className="ai-analysis-level-badge">おすすめ</span>
            </label>
            <label
              className={`ai-analysis-level ${
                analysisLevel === "detailed" ? "is-selected" : ""
              }`}
            >
              <input
                type="radio"
                name="ai-analysis-level"
                value="detailed"
                checked={analysisLevel === "detailed"}
                onChange={() => setAnalysisLevel("detailed")}
              />
              <span className="ai-analysis-level-copy">
                <strong>詳細</strong>
                <span>Danbooru系・細粒度タグ</span>
                <small>
                  信頼度60%以上を、分類・スコア付きで最大120件保存します。
                </small>
              </span>
            </label>
          </fieldset>

          <div className="ai-analysis-model-card">
            <div className="ai-analysis-model-heading">
              <div>
                <span className="ai-analysis-model-name">
                  {model?.modelName ?? "WD v1.4 MOAT Tagger V2"}
                </span>
                <span className="ai-analysis-model-meta">
                  {model?.license ?? "Apache-2.0"} ・{" "}
                  {formatBytes(model?.totalDownloadBytes ?? 326_451_246)}
                </span>
              </div>
              <span
                className={`ai-analysis-model-state ${
                  model?.verified ? "is-ready" : ""
                }`}
              >
                {model?.verified ? "検証済み" : "初回取得"}
              </span>
            </div>
            <p>
              初回のみモデルをダウンロードし、SHA-256を検証します。画像は外部へ送信せず、
              このPC上のONNX Runtimeで解析します。
            </p>
            <p className="ai-analysis-definition-note">
              「AIタグ定義」は、モデルが返すスコアの並びをDanbooru系のタグ名・分類へ対応付ける
              CSVです。画像の送信や追加学習ではなく、初回に読み込んだ後はメモリへキャッシュします。
            </p>
            <a
              href="https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2"
              target="_blank"
              rel="noreferrer"
            >
              モデルとライセンスの詳細
            </a>
          </div>

          {progress && progress.phase !== "idle" && (
            <div className={`ai-analysis-progress-card is-${statusTone}`}>
              <div className="ai-analysis-progress-heading">
                <div className="ai-analysis-progress-copy">
                  <span>{progress.message}</span>
                  <strong>{percent}%</strong>
                </div>
                {active && (
                  <div className="ai-analysis-progress-actions">
                    <button
                      type="button"
                      disabled={pausePending || cancelPending}
                      title={progress.phase === "paused" ? "AI分析を再開" : "AI分析を一時停止"}
                      onClick={() => void handlePauseToggle()}
                    >
                      <Icon name={progress.phase === "paused" ? "play" : "pause"} />
                      <span>{progress.phase === "paused" ? "再開" : "一時停止"}</span>
                    </button>
                    <button
                      type="button"
                      disabled={cancelPending || progress.phase === "cancelling"}
                      title="AI分析を停止"
                      onClick={handleCancel}
                    >
                      <Icon name="stop" />
                      <span>{progress.phase === "cancelling" ? "停止中…" : "停止"}</span>
                    </button>
                  </div>
                )}
              </div>
              <div
                className="ai-analysis-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <span style={{ width: `${percent}%` }} />
              </div>
              {progress.currentName && (
                <div className="ai-analysis-current-media">
                  {progress.currentPath && localAssetUrl(progress.currentPath) ? (
                    <img
                      src={localAssetUrl(progress.currentPath)}
                      alt=""
                      decoding="async"
                    />
                  ) : (
                    <span><Icon name="image" /></span>
                  )}
                  <div>
                    <p className="ai-analysis-current-name">{progress.currentName}</p>
                    <small>
                      {progress.currentItem.toLocaleString("ja-JP")} / {progress.totalItems.toLocaleString("ja-JP")} 件
                    </small>
                  </div>
                </div>
              )}
              {terminalPhases.has(progress.phase) && (
                <div className="ai-analysis-results">
                  <div className="ai-analysis-result-row">
                    <span>完了 {progress.analyzedItems}件</span>
                    {progress.detectedTags > 0 && (
                      <span>タグ {progress.detectedTags}件</span>
                    )}
                    {progress.failedItems > 0 && (
                      <span>失敗 {progress.failedItems}件</span>
                    )}
                    {progress.skippedItems > 0 && (
                      <span>対象外 {progress.skippedItems}件</span>
                    )}
                  </div>
                  {progress.analysisLevel === "detailed" &&
                    progress.categoryCounts.length > 0 && (
                      <div
                        className="ai-analysis-category-counts"
                        aria-label="タグ分類別の検出数"
                      >
                        {progress.categoryCounts.map(({ category, count }) => (
                          <span key={category}>
                            {categoryLabels[category] ?? category} {count}
                          </span>
                        ))}
                      </div>
                    )}
                  {progress.previewTags.length > 0 && (
                      <div className="ai-analysis-tag-preview">
                        <p>
                          {progress.previewName
                            ? `「${progress.previewName}」の上位タグ`
                            : "上位タグ"}
                        </p>
                        <div>
                          {progress.previewTags.map((tag) => (
                            <span
                              key={`${tag.category}:${tag.name}`}
                              title={tag.name.replace(/_/g, " ")}
                              style={{
                                "--ai-tag-confidence": `${Math.round(tag.confidence * 100)}%`,
                              } as CSSProperties}
                            >
                              <small>
                                {categoryLabels[tag.category] ?? tag.category}
                              </small>
                              {translateTag(tag.name)}
                              <strong>
                                {Math.round(tag.confidence * 100)}%
                              </strong>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              )}
              {progress.phase === "cancelled" && progress.cleanupPending && (
                <p className="ai-analysis-cleanup-note">
                  キャンセルは完了しています。現在のネイティブ処理が安全に終了するまで、
                  新しい分析だけ一時的に待機します。この画面は閉じて構いません。
                </p>
              )}
            </div>
          )}

          {error && <p className="ai-analysis-error">{error}</p>}

          <p className="ai-analysis-note">
            AIタグだけを再生成します。手動で付けたタグと年齢区分は保持されます。
            どちらも信頼度60%以上だけを保存し、詳細は分類付きで最大120件まで候補を残します。
            外部AIや架空のタグは生成しません。
          </p>
        </div>

        <footer className="ai-analysis-actions">
          {active ? (
            <div className="ai-analysis-running-actions">
              <button
                type="button"
                className="ai-analysis-secondary-button"
                onClick={onClose}
              >
                バックグラウンドへ
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="ai-analysis-secondary-button"
              onClick={onClose}
            >
              閉じる
            </button>
          )}
          <button
            type="button"
            className="ai-analysis-primary-button"
            disabled={
              !analysisScope ||
              !scopeCount ||
              scopeLoading ||
              active ||
              progress?.cleanupPending ||
              starting
            }
            onClick={handleStart}
          >
            {starting
              ? "準備中…"
              : progress?.cleanupPending
                ? "停止処理の完了待ち"
              : model?.installed
                ? "AI分析を開始"
                : "モデルを取得して分析"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default AIAnalysisModal;
