import { useEffect } from "react";

import {
  getAiAnalysisStatus,
  isAiAnalysisActive,
  listenToAiAnalysis,
  type AiAnalysisProgress,
} from "../services/ai";
import { notifyApp } from "../services/notifications";

type AiAnalysisStartedDetail = {
  jobId: string;
  targetLabel: string;
};

/**
 * Bridges native completion into gallery refreshes. Live AI progress is owned
 * by AiAnalysisMonitor rather than the generic OperationTray, avoiding two
 * competing progress cards for the same job.
 */
export function useAiOperationBridge(): void {
  useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | undefined;
    const observedJobs = new Set<string>();
    const settledJobs = new Set<string>();
    const targetLabels = new Map<string, string>();

    const rememberTarget = (event: Event) => {
      const detail = (event as CustomEvent<AiAnalysisStartedDetail>).detail;
      if (detail?.jobId && detail.targetLabel) {
        targetLabels.set(detail.jobId, detail.targetLabel);
      }
    };

    const receive = (progress: AiAnalysisProgress) => {
      if (disposed || !progress.jobId || progress.phase === "idle") return;
      if (isAiAnalysisActive(progress.phase)) {
        observedJobs.add(progress.jobId);
        return;
      }
      if (!observedJobs.has(progress.jobId) || settledJobs.has(progress.jobId)) return;
      settledJobs.add(progress.jobId);
      const targetLabel = targetLabels.get(progress.jobId) ?? "選択した範囲";
      if (progress.phase === "completed") {
        notifyApp({
          tone: "success",
          title: "AI分析が完了しました",
          message: `「${targetLabel}」のAI分析が完了しました（${progress.analyzedItems.toLocaleString("ja-JP")}件）`,
        });
        window.dispatchEvent(
          new CustomEvent("pixvault:ai-analysis-completed", {
            detail: progress,
          }),
        );
      } else if (progress.phase === "cancelled") {
        notifyApp({
          tone: "info",
          title: "AI分析を停止しました",
          message: `「${targetLabel}」のAI分析を停止しました。`,
        });
      } else if (progress.phase === "failed") {
        notifyApp({
          tone: "error",
          title: "AI分析に失敗しました",
          message: progress.error ?? `「${targetLabel}」のAI分析を完了できませんでした。`,
        });
      }
      observedJobs.delete(progress.jobId);
      targetLabels.delete(progress.jobId);
    };

    window.addEventListener("pixvault:ai-analysis-started", rememberTarget);

    void (async () => {
      try {
        const unlisten = await listenToAiAnalysis(receive);
        if (disposed) {
          unlisten();
          return;
        }
        removeListener = unlisten;
        const current = await getAiAnalysisStatus();
        if (current.jobId && isAiAnalysisActive(current.phase)) receive(current);
      } catch {
        // The dedicated monitor and analysis modal still show command errors.
        // A failed bridge must never prevent the rest of the app rendering.
      }
    })();

    return () => {
      disposed = true;
      removeListener?.();
      window.removeEventListener("pixvault:ai-analysis-started", rememberTarget);
    };
  }, []);
}
