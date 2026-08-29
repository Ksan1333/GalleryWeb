import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  cancelAiAnalysis,
  getAiAnalysisStatus,
  isAiAnalysisActive,
  listenToAiAnalysis,
  sampleSystemLoad,
  setAiAnalysisPaused,
  type AiAnalysisProgress,
  type AiCompletedItem,
  type SystemLoadSample,
} from "../services/ai";
import { localAssetUrl } from "../services/native";
import { useTagTranslations } from "../services/tagTranslations";
import { useFloatingPanel } from "../hooks/useFloatingPanel";
import { Icon } from "./Icon";
import "./AiAnalysisMonitor.css";

type MonitorMode = "normal" | "expanded";

const MAX_COMPLETED_HISTORY = 30;
const MAX_LOAD_SAMPLES = 80;
const LOAD_SAMPLE_INTERVAL_MS = 1_500;

function progressPercent(progress: AiAnalysisProgress): number {
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
  const processed =
    progress.analyzedItems + progress.failedItems + progress.skippedItems;
  return Math.min(99, Math.round((processed / progress.totalItems) * 100));
}

function phaseLabel(progress: AiAnalysisProgress): string {
  switch (progress.phase) {
    case "queued":
      return "待機中";
    case "verifying":
      return "モデル検証";
    case "downloading":
      return "モデル取得";
    case "loading":
      return "モデル読込";
    case "preprocessing":
      return "画像準備";
    case "analyzing":
      return "AI解析";
    case "saving":
      return "結果保存";
    case "paused":
      return "一時停止";
    case "cancelling":
      return "停止中";
    case "completed":
      return "完了";
    case "cancelled":
      return "停止";
    case "failed":
      return "失敗";
    default:
      return "待機中";
  }
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "算出中";
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}時間 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${remainder}秒`;
  return `${remainder}秒`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1_024)),
    units.length - 1,
  );
  const scaled = value / 1_024 ** index;
  return `${scaled >= 10 || index === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`;
}

function ageLabel(value: string): string {
  if (value === "UNRATED") return "未選択";
  if (value === "SFW") return "健全";
  if (value === "R15") return "R-15";
  if (value === "R18") return "R-18";
  return value || "未分類";
}

function SystemLoadGraph({ samples }: { samples: SystemLoadSample[] }) {
  const width = 640;
  const height = 190;
  const inset = 18;
  const plotHeight = height - inset * 2;
  const pointsFor = (selector: (sample: SystemLoadSample) => number | null) =>
    samples
      .map((sample, index) => {
        const value = selector(sample);
        if (value === null) return undefined;
        const x =
          samples.length <= 1
            ? inset
            : inset + (index / (samples.length - 1)) * (width - inset * 2);
        const y = inset + (1 - Math.min(100, Math.max(0, value)) / 100) * plotHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  const cpuPoints = pointsFor((sample) => sample.cpuPercent);
  const memoryPoints = pointsFor((sample) => sample.memoryPercent);
  const latest = samples[samples.length - 1];

  return (
    <section className="ai-monitor-load-card" aria-labelledby="ai-monitor-load-title">
      <div className="ai-monitor-section-heading">
        <div>
          <span>PERFORMANCE</span>
          <h3 id="ai-monitor-load-title">PC負荷</h3>
        </div>
        <div className="ai-monitor-load-legend">
          <span className="is-cpu">
            CPU <strong>{latest?.cpuPercent == null ? "計測中" : `${Math.round(latest.cpuPercent)}%`}</strong>
          </span>
          <span className="is-memory">
            メモリ <strong>{latest?.memoryPercent == null ? "—" : `${Math.round(latest.memoryPercent)}%`}</strong>
          </span>
        </div>
      </div>
      <div className="ai-monitor-chart">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="CPUとメモリ使用率の時系列グラフ"
          preserveAspectRatio="none"
        >
          {[0, 25, 50, 75, 100].map((value) => {
            const y = inset + (1 - value / 100) * plotHeight;
            return (
              <g key={value}>
                <line x1={inset} x2={width - inset} y1={y} y2={y} />
                <text x={inset + 3} y={y - 4}>{value}%</text>
              </g>
            );
          })}
          {memoryPoints && <polyline className="is-memory" points={memoryPoints} />}
          {cpuPoints && <polyline className="is-cpu" points={cpuPoints} />}
        </svg>
        {samples.length < 2 && (
          <div className="ai-monitor-chart-empty">負荷データを計測しています…</div>
        )}
      </div>
      <div className="ai-monitor-memory-copy">
        <span>使用メモリ</span>
        <strong>
          {latest
            ? `${formatBytes(latest.usedMemoryBytes)} / ${formatBytes(latest.totalMemoryBytes)}`
            : "計測中"}
        </strong>
      </div>
    </section>
  );
}

function CompletedItemCard({
  item,
  translateTag,
}: {
  item: AiCompletedItem;
  translateTag: (name: string) => string;
}) {
  const source = localAssetUrl(item.path);
  return (
    <article className="ai-monitor-completed-item">
      <div className="ai-monitor-completed-thumb">
        {source ? (
          <img src={source} alt="" decoding="async" loading="lazy" />
        ) : (
          <Icon name="image" />
        )}
        <span className={`is-${item.ageRating.toLowerCase()}`}>
          {ageLabel(item.ageRating)}
        </span>
      </div>
      <div className="ai-monitor-completed-copy">
        <strong title={item.name}>{item.name}</strong>
        <small title={item.path}>{item.path}</small>
        <div className="ai-monitor-completed-tags">
          {item.tags.length > 0 ? (
            item.tags.map((tag) => {
              const confidence = Math.round(tag.confidence * 100);
              const style = {
                "--confidence": `${confidence}%`,
              } as CSSProperties;
              return (
                <span
                  key={`${tag.category}:${tag.name}`}
                  style={style}
                  title={`${tag.name.replace(/_/g, " ")} · ${confidence}%`}
                >
                  <b>{translateTag(tag.name)}</b>
                  <em>{confidence}%</em>
                </span>
              );
            })
          ) : (
            <span className="is-empty">60%以上のタグなし</span>
          )}
        </div>
      </div>
    </article>
  );
}

export function AiAnalysisMonitor({ hidden = false }: { hidden?: boolean }) {
  const [progress, setProgress] = useState<AiAnalysisProgress>();
  const [mode, setMode] = useState<MonitorMode>("normal");
  const [completedItems, setCompletedItems] = useState<AiCompletedItem[]>([]);
  const [loadSamples, setLoadSamples] = useState<SystemLoadSample[]>([]);
  const [metricsError, setMetricsError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const [compact, setCompact] = useState(false);
  const [dismissedJobId, setDismissedJobId] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const completedKeys = useRef(new Set<string>());
  const currentJobId = useRef<string | undefined>(undefined);
  const translateTag = useTagTranslations();
  const { panelRef, floatingStyle, onDragPointerDown } = useFloatingPanel<HTMLElement>({
    storageKey: "pixvault-ai-background-position",
    layoutKey: `${mode}:${hidden ? "hidden" : progress?.jobId ?? "idle"}`,
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const receive = (next: AiAnalysisProgress) => {
      if (disposed || !next.jobId || next.phase === "idle") return;
      if (currentJobId.current !== next.jobId) {
        currentJobId.current = next.jobId;
        completedKeys.current.clear();
        setCompletedItems([]);
        setLoadSamples([]);
        setMetricsError(undefined);
        setMode("normal");
        setDismissedJobId(undefined);
      }
      const item = next.latestCompletedItem;
      if (item) {
        const key = `${next.jobId}:${next.analyzedItems}:${item.mediaId}`;
        if (!completedKeys.current.has(key)) {
          completedKeys.current.add(key);
          setCompletedItems((current) =>
            [item, ...current].slice(0, MAX_COMPLETED_HISTORY),
          );
        }
      }
      setProgress(next);
    };

    void listenToAiAnalysis(receive).then((remove) => {
      if (disposed) remove();
      else unlisten = remove;
    });
    void getAiAnalysisStatus().then(receive).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const active = progress ? isAiAnalysisActive(progress.phase) : false;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (mode !== "expanded" || !active) return;
    let disposed = false;
    let requestRunning = false;
    const sample = async () => {
      if (disposed || requestRunning) return;
      requestRunning = true;
      try {
        const next = await sampleSystemLoad();
        if (!disposed) {
          setLoadSamples((current) =>
            [...current, next].slice(-MAX_LOAD_SAMPLES),
          );
          setMetricsError(undefined);
        }
      } catch (error) {
        if (!disposed) {
          setMetricsError(
            error instanceof Error ? error.message : "PC負荷を取得できませんでした",
          );
        }
      } finally {
        requestRunning = false;
      }
    };
    void sample();
    const timer = window.setInterval(() => void sample(), LOAD_SAMPLE_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, mode]);

  useEffect(() => {
    if (mode !== "normal") {
      setCompact(false);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const update = () => setCompact(panel.getBoundingClientRect().width < 360);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [mode, panelRef, progress?.jobId]);

  const timing = useMemo(() => {
    if (!progress) return { elapsed: 0, remaining: undefined };
    const startedAt = progress.startedAtMs ?? now;
    const endedAt = progress.finishedAtMs ?? now;
    const elapsed = Math.max(0, endedAt - startedAt);
    const processed =
      progress.analyzedItems + progress.failedItems + progress.skippedItems;
    const remainingItems = Math.max(0, progress.totalItems - processed);
    const remaining =
      active && processed > 0 && elapsed > 0
        ? (elapsed / processed) * remainingItems
        : active && remainingItems === 0
          ? 0
          : undefined;
    return { elapsed, remaining };
  }, [active, now, progress]);

  if (
    hidden ||
    !progress ||
    !progress.jobId ||
    progress.phase === "idle" ||
    dismissedJobId === progress.jobId
  ) {
    return null;
  }

  const percent = progressPercent(progress);
  const processed =
    progress.analyzedItems + progress.failedItems + progress.skippedItems;
  const remaining = Math.max(0, progress.totalItems - processed);
  const currentSource = localAssetUrl(progress.currentPath);

  const stop = async () => {
    if (!active || stopping) return;
    setStopping(true);
    try {
      await cancelAiAnalysis(progress.jobId);
    } finally {
      setStopping(false);
    }
  };

  const togglePaused = async () => {
    if (!active || pausePending) return;
    setPausePending(true);
    try {
      await setAiAnalysisPaused(progress.phase !== "paused", progress.jobId);
    } finally {
      setPausePending(false);
    }
  };

  if (mode === "expanded") {
    return (
      <aside className="ai-monitor ai-monitor-expanded" aria-label="AI分析モニター最大表示">
        <header className="ai-monitor-expanded-header">
          <div className="ai-monitor-brand">
            <span className={active ? "is-live" : ""}><Icon name="sparkles" /></span>
            <div>
              <small>PIXVAULT BACKGROUND PROCESS</small>
              <h2>AI・ベクトル分析</h2>
            </div>
          </div>
          <div className="ai-monitor-header-status">
            <span className={`is-${progress.phase}`}>{phaseLabel(progress)}</span>
            <strong>{percent}%</strong>
          </div>
          <div className="ai-monitor-window-actions">
            {active && (
              <>
                <button className="is-pause" type="button" disabled={pausePending || stopping} onClick={() => void togglePaused()} title={progress.phase === "paused" ? "AI分析を再開" : "AI分析を一時停止"}>
                  <Icon name={progress.phase === "paused" ? "play" : "pause"} /><span>{progress.phase === "paused" ? "再開" : "一時停止"}</span>
                </button>
                <button className="is-stop" type="button" disabled={stopping} onClick={() => void stop()} title="AI分析を停止">
                  <Icon name="stop" /><span>{stopping ? "停止中…" : "停止"}</span>
                </button>
              </>
            )}
            {!active && (
              <button type="button" onClick={() => setDismissedJobId(progress.jobId)} aria-label="AI分析結果を閉じる" title="閉じる">
                <Icon name="close" />
              </button>
            )}
            <button type="button" onClick={() => setMode("normal")} aria-label="通常表示" title="通常表示">
              <Icon name="fullscreenExit" />
            </button>
          </div>
        </header>

        <div className="ai-monitor-expanded-progress">
          <span style={{ width: `${percent}%` }} />
        </div>

        <div className="ai-monitor-dashboard">
          <section className="ai-monitor-overview">
            <div className="ai-monitor-stat is-completed">
              <span>完了</span><strong>{progress.analyzedItems.toLocaleString("ja-JP")}</strong><small>items</small>
            </div>
            <div className="ai-monitor-stat is-failed">
              <span>失敗</span><strong>{progress.failedItems.toLocaleString("ja-JP")}</strong><small>items</small>
            </div>
            <div className="ai-monitor-stat is-skipped">
              <span>スキップ</span><strong>{progress.skippedItems.toLocaleString("ja-JP")}</strong><small>items</small>
            </div>
            <div className="ai-monitor-stat is-remaining">
              <span>残り</span><strong>{remaining.toLocaleString("ja-JP")}</strong><small>items</small>
            </div>
            <div className="ai-monitor-time-stat">
              <span><Icon name="clock" /> 経過</span>
              <strong>{formatDuration(timing.elapsed)}</strong>
              <small>推定残り {formatDuration(timing.remaining)}</small>
            </div>
          </section>

          <div className="ai-monitor-dashboard-grid">
            <SystemLoadGraph samples={loadSamples} />
            <section className="ai-monitor-current-card">
              <div className="ai-monitor-section-heading">
                <div><span>NOW PROCESSING</span><h3>現在のファイル</h3></div>
                <strong>{progress.currentItem.toLocaleString("ja-JP")} / {progress.totalItems.toLocaleString("ja-JP")}</strong>
              </div>
              <div className="ai-monitor-current-media">
                <div>
                  {currentSource ? (
                    <img src={currentSource} alt="" decoding="async" />
                  ) : (
                    <Icon name="image" />
                  )}
                </div>
                <section>
                  <span>{phaseLabel(progress)}</span>
                  <strong title={progress.currentName}>{progress.currentName ?? "処理を終了しました"}</strong>
                  <small title={progress.currentPath}>{progress.currentPath ?? progress.message}</small>
                </section>
              </div>
              <div className="ai-monitor-current-message">{progress.message}</div>
              {progress.error && <p className="ai-monitor-error">{progress.error}</p>}
              {metricsError && <p className="ai-monitor-metrics-note">{metricsError}</p>}
            </section>
          </div>

          <section className="ai-monitor-completed-section">
            <div className="ai-monitor-section-heading">
              <div><span>LIVE RESULTS</span><h3>完了した画像</h3></div>
              <strong>直近 {completedItems.length} / 最大 {MAX_COMPLETED_HISTORY}件</strong>
            </div>
            {completedItems.length > 0 ? (
              <div className="ai-monitor-completed-list">
                {completedItems.map((item, index) => (
                  <CompletedItemCard
                    item={item}
                    key={`${item.mediaId}:${index}`}
                    translateTag={translateTag}
                  />
                ))}
              </div>
            ) : (
              <div className="ai-monitor-results-empty">
                <Icon name="sparkles" />
                <strong>最初の分析結果を待っています</strong>
                <span>1件完了するたびに、画像・タグ・信頼度・年齢区分をここへ表示します。</span>
              </div>
            )}
          </section>
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={panelRef}
      className={`ai-monitor ai-monitor-normal${compact ? " is-compact" : ""}`}
      style={floatingStyle}
      aria-label="AI分析モニター"
    >
      <header onPointerDown={onDragPointerDown}>
        <div className="ai-monitor-brand">
          <span className={active ? "is-live" : ""}><Icon name="sparkles" /></span>
          <div><small>BACKGROUND PROCESS</small><strong>{phaseLabel(progress)}</strong></div>
        </div>
        <div className="ai-monitor-window-actions">
          <button type="button" onClick={() => setMode("expanded")} aria-label="最大表示" title="最大表示"><Icon name="fullscreen" /></button>
          {!active && (
            <button type="button" onClick={() => setDismissedJobId(progress.jobId)} aria-label="AI分析結果を閉じる" title="閉じる"><Icon name="close" /></button>
          )}
        </div>
      </header>
      <div className="ai-monitor-normal-body">
        <div className="ai-monitor-normal-current">
          <div>{currentSource ? <img src={currentSource} alt="" decoding="async" /> : <Icon name="image" />}</div>
          <section>
            <strong title={progress.currentName}>{progress.currentName ?? progress.message}</strong>
            <span>{processed.toLocaleString("ja-JP")} / {progress.totalItems.toLocaleString("ja-JP")}件 · 残り {remaining.toLocaleString("ja-JP")}件</span>
          </section>
          <b>{percent}%</b>
        </div>
        <div className="ai-monitor-normal-track"><span style={{ width: `${percent}%` }} /></div>
        <div className="ai-monitor-normal-meta">
          <span>経過 {formatDuration(timing.elapsed)}</span>
          <span>残り {formatDuration(timing.remaining)}</span>
          {active && (
            <span className="ai-monitor-normal-actions">
              <button className="is-pause" type="button" disabled={pausePending || stopping} onClick={() => void togglePaused()}>
                <Icon name={progress.phase === "paused" ? "play" : "pause"} />{progress.phase === "paused" ? "再開" : "一時停止"}
              </button>
              <button className="is-stop" type="button" disabled={stopping} onClick={() => void stop()}>
                <Icon name="stop" />{stopping ? "停止中" : "停止"}
              </button>
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}

export default AiAnalysisMonitor;
