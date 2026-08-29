const PERFORMANCE_PREFIX = "pixvault:";

export const performanceMilestones = {
  appStart: `${PERFORMANCE_PREFIX}app-start`,
  reactMounted: `${PERFORMANCE_PREFIX}react-mounted`,
  firstMediaCard: `${PERFORMANCE_PREFIX}first-media-card`,
  firstMediaThumbnail: `${PERFORMANCE_PREFIX}first-media-thumbnail`,
} as const;

type PerformanceMilestone =
  (typeof performanceMilestones)[keyof typeof performanceMilestones];

export type PerformanceSnapshot = {
  capturedAt: string;
  monitoringEnabled: boolean;
  timeOrigin: number;
  marks: Record<string, number>;
  measures: Record<string, number>;
  frames: {
    sampleCount: number;
    averageFps?: number;
    p95FrameTimeMs?: number;
    worstFrameTimeMs?: number;
    slowFrameCount: number;
  };
  longTasks: {
    count: number;
    totalDurationMs: number;
    longestDurationMs: number;
  };
  dom: {
    totalNodes: number;
    mediaCards: number;
    images: number;
    videos: number;
    canvases: number;
  };
  memory?: {
    usedJsHeapBytes: number;
    totalJsHeapBytes: number;
    jsHeapLimitBytes: number;
  };
};

type PerformanceDebugApi = {
  snapshot: () => PerformanceSnapshot;
  print: () => PerformanceSnapshot;
  resetSamples: () => void;
  mark: (name: PerformanceMilestone) => void;
  markFirstMediaCard: () => void;
  markFirstMediaThumbnail: () => void;
};

declare global {
  interface Window {
    __PIXVAULT_PERFORMANCE__?: PerformanceDebugApi;
  }
}

const FRAME_SAMPLE_LIMIT = 3_600;
const SLOW_FRAME_THRESHOLD_MS = 25;
const frameDurations: number[] = [];
let longTaskCount = 0;
let longTaskTotalDuration = 0;
let longestLongTask = 0;
let monitoringEnabled = false;
let frameRequest: number | undefined;
let previousFrameAt: number | undefined;
let longTaskObserver: PerformanceObserver | undefined;

function hasPerformanceApi(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

function markOnce(name: PerformanceMilestone, startTime?: number): void {
  if (!hasPerformanceApi() || performance.getEntriesByName(name, "mark").length > 0) return;
  try {
    performance.mark(name, startTime === undefined ? undefined : { startTime });
  } catch {
    performance.mark(name);
  }
}

function measureOnce(name: string, start: PerformanceMilestone, end: PerformanceMilestone): void {
  if (
    !hasPerformanceApi()
    || performance.getEntriesByName(name, "measure").length > 0
    || performance.getEntriesByName(start, "mark").length === 0
    || performance.getEntriesByName(end, "mark").length === 0
  ) return;
  try {
    performance.measure(name, start, end);
  } catch {
    // A missing or browser-rejected mark must never affect application startup.
  }
}

export function markAppStart(): void {
  // Navigation start is the earliest timestamp available to the WebView. The
  // native process can add an earlier mark later without changing this API.
  markOnce(performanceMilestones.appStart, 0);
}

export function markReactMounted(): void {
  markOnce(performanceMilestones.reactMounted);
  measureOnce(
    `${PERFORMANCE_PREFIX}time-to-react-mounted`,
    performanceMilestones.appStart,
    performanceMilestones.reactMounted,
  );
}

export function markFirstMediaCard(): void {
  markOnce(performanceMilestones.firstMediaCard);
  measureOnce(
    `${PERFORMANCE_PREFIX}time-to-first-media-card`,
    performanceMilestones.appStart,
    performanceMilestones.firstMediaCard,
  );
}

export function markFirstMediaThumbnail(): void {
  markOnce(performanceMilestones.firstMediaThumbnail);
  measureOnce(
    `${PERFORMANCE_PREFIX}time-to-first-media-thumbnail`,
    performanceMilestones.appStart,
    performanceMilestones.firstMediaThumbnail,
  );
}

function detailedMonitoringRequested(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("perf") === "1"
      || window.localStorage.getItem("pixvault:performance") === "1";
  } catch {
    return false;
  }
}

function recordFrame(timestamp: number): void {
  if (document.visibilityState !== "visible") {
    previousFrameAt = undefined;
  } else if (previousFrameAt !== undefined) {
    frameDurations.push(timestamp - previousFrameAt);
    if (frameDurations.length > FRAME_SAMPLE_LIMIT) frameDurations.shift();
  }
  previousFrameAt = timestamp;
  frameRequest = window.requestAnimationFrame(recordFrame);
}

function percentile(values: readonly number[], percentileValue: number): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * percentileValue) - 1),
  );
  return ordered[index];
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function timingEntries(type: "mark" | "measure"): Record<string, number> {
  if (!hasPerformanceApi()) return {};
  return Object.fromEntries(
    performance
      .getEntriesByType(type)
      .filter((entry) => entry.name.startsWith(PERFORMANCE_PREFIX))
      .map((entry) => [
        entry.name.slice(PERFORMANCE_PREFIX.length),
        rounded(type === "mark" ? entry.startTime : entry.duration),
      ]),
  );
}

function memorySnapshot(): PerformanceSnapshot["memory"] {
  const memory = (performance as Performance & {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  }).memory;
  if (!memory) return undefined;
  return {
    usedJsHeapBytes: memory.usedJSHeapSize,
    totalJsHeapBytes: memory.totalJSHeapSize,
    jsHeapLimitBytes: memory.jsHeapSizeLimit,
  };
}

export function getPerformanceSnapshot(): PerformanceSnapshot {
  const meanFrameTime = frameDurations.length > 0
    ? frameDurations.reduce((total, duration) => total + duration, 0) / frameDurations.length
    : undefined;
  const allNodes = typeof document === "undefined"
    ? []
    : document.getElementsByTagName("*");
  return {
    capturedAt: new Date().toISOString(),
    monitoringEnabled,
    timeOrigin: hasPerformanceApi() ? performance.timeOrigin : 0,
    marks: timingEntries("mark"),
    measures: timingEntries("measure"),
    frames: {
      sampleCount: frameDurations.length,
      averageFps: meanFrameTime && meanFrameTime > 0 ? rounded(1_000 / meanFrameTime) : undefined,
      p95FrameTimeMs: percentile(frameDurations, 0.95),
      worstFrameTimeMs: frameDurations.length > 0 ? Math.max(...frameDurations) : undefined,
      slowFrameCount: frameDurations.filter(
        (duration) => duration > SLOW_FRAME_THRESHOLD_MS,
      ).length,
    },
    longTasks: {
      count: longTaskCount,
      totalDurationMs: rounded(longTaskTotalDuration),
      longestDurationMs: rounded(longestLongTask),
    },
    dom: {
      totalNodes: allNodes.length,
      mediaCards: typeof document === "undefined"
        ? 0
        : document.querySelectorAll("[data-media-id]").length,
      images: typeof document === "undefined" ? 0 : document.images.length,
      videos: typeof document === "undefined" ? 0 : document.querySelectorAll("video").length,
      canvases: typeof document === "undefined" ? 0 : document.querySelectorAll("canvas").length,
    },
    memory: hasPerformanceApi() ? memorySnapshot() : undefined,
  };
}

export function resetPerformanceSamples(): void {
  frameDurations.length = 0;
  longTaskCount = 0;
  longTaskTotalDuration = 0;
  longestLongTask = 0;
  previousFrameAt = undefined;
}

export function startPerformanceMonitoring(): void {
  if (monitoringEnabled || !detailedMonitoringRequested() || typeof window === "undefined") return;
  monitoringEnabled = true;

  if (
    typeof PerformanceObserver !== "undefined"
    && PerformanceObserver.supportedEntryTypes.includes("longtask")
  ) {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskTotalDuration += entry.duration;
        longestLongTask = Math.max(longestLongTask, entry.duration);
      }
    });
    try {
      longTaskObserver.observe({ type: "longtask", buffered: true });
    } catch {
      longTaskObserver.disconnect();
      longTaskObserver = undefined;
    }
  }

  frameRequest = window.requestAnimationFrame(recordFrame);
  window.__PIXVAULT_PERFORMANCE__ = {
    snapshot: getPerformanceSnapshot,
    print: () => {
      const snapshot = getPerformanceSnapshot();
      console.table({
        ...snapshot.measures,
        averageFps: snapshot.frames.averageFps,
        p95FrameTimeMs: snapshot.frames.p95FrameTimeMs,
        longTasks: snapshot.longTasks.count,
        domNodes: snapshot.dom.totalNodes,
      });
      return snapshot;
    },
    resetSamples: resetPerformanceSamples,
    mark: markOnce,
    markFirstMediaCard,
    markFirstMediaThumbnail,
  };
}

export function stopPerformanceMonitoring(): void {
  if (!monitoringEnabled) return;
  monitoringEnabled = false;
  longTaskObserver?.disconnect();
  longTaskObserver = undefined;
  if (frameRequest !== undefined) window.cancelAnimationFrame(frameRequest);
  frameRequest = undefined;
  previousFrameAt = undefined;
  if (window.__PIXVAULT_PERFORMANCE__) delete window.__PIXVAULT_PERFORMANCE__;
}

// Evaluate this module before the application tree so the mark also includes
// React/App module evaluation and the first render.
markAppStart();
