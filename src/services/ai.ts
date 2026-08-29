import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isTauriRuntime } from "./native";

export const AI_ANALYSIS_PROGRESS_EVENT = "ai-analysis-progress";
export type AiAnalysisLevel = "standard" | "detailed";

export type AiCategoryCount = {
  category: "general" | "character" | "copyright" | "artist" | "meta" | "other";
  count: number;
};

export type AiTagPreview = {
  name: string;
  category: AiCategoryCount["category"];
  confidence: number;
};

export type AiCompletedItem = {
  mediaId: string;
  name: string;
  path: string;
  ageRating: "SFW" | "R15" | "R18" | string;
  tags: AiTagPreview[];
};

export type AiAnalysisPhase =
  | "idle"
  | "queued"
  | "verifying"
  | "downloading"
  | "loading"
  | "preprocessing"
  | "analyzing"
  | "saving"
  | "paused"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export type AiAnalysisProgress = {
  jobId?: string;
  phase: AiAnalysisPhase;
  message: string;
  currentItem: number;
  totalItems: number;
  currentName?: string;
  currentPath?: string;
  downloadedBytes: number;
  downloadTotalBytes: number;
  analyzedItems: number;
  failedItems: number;
  skippedItems: number;
  analysisLevel: AiAnalysisLevel;
  startedAtMs?: number;
  finishedAtMs?: number;
  detectedTags: number;
  categoryCounts: AiCategoryCount[];
  previewName?: string;
  previewTags: AiTagPreview[];
  latestCompletedItem?: AiCompletedItem;
  /** The cancelled worker is leaving an uninterruptible native section. */
  cleanupPending: boolean;
  error?: string;
};

export type AiModelStatus = {
  installed: boolean;
  verified: boolean;
  modelName: string;
  repository: string;
  revision: string;
  license: string;
  modelBytes: number;
  tagsBytes: number;
  totalDownloadBytes: number;
  installDirectory: string;
};

export type AiJobStart = {
  jobId: string;
  totalItems: number;
  skippedItems: number;
  analysisLevel: AiAnalysisLevel;
};

export type AiAnalysisScope = {
  rootId?: string;
  folderPath?: string;
  includeSubfolders: boolean;
  /** Inclusive Unix timestamp in milliseconds. */
  modifiedFrom?: number;
  /** Exclusive Unix timestamp in milliseconds. */
  modifiedBefore?: number;
};

export type AiAnalysisScopePreview = {
  analyzableItems: number;
};

export type SystemLoadSample = {
  timestampMs: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  usedMemoryBytes: number;
  totalMemoryBytes: number;
};

const browserModelStatus: AiModelStatus = {
  installed: false,
  verified: false,
  modelName: "WD v1.4 MOAT Tagger V2",
  repository: "SmilingWolf/wd-v1-4-moat-tagger-v2",
  revision: "8452cddf280b952281b6e102411c50e981cb2908",
  license: "Apache-2.0",
  modelBytes: 326_197_340,
  tagsBytes: 253_906,
  totalDownloadBytes: 326_451_246,
  installDirectory: "",
};

const browserProgress: AiAnalysisProgress = {
  phase: "idle",
  message: "AI分析はデスクトップアプリで利用できます",
  currentItem: 0,
  totalItems: 0,
  downloadedBytes: 0,
  downloadTotalBytes: browserModelStatus.totalDownloadBytes,
  analyzedItems: 0,
  failedItems: 0,
  skippedItems: 0,
  analysisLevel: "standard",
  startedAtMs: undefined,
  finishedAtMs: undefined,
  detectedTags: 0,
  categoryCounts: [],
  previewTags: [],
  latestCompletedItem: undefined,
  cleanupPending: false,
};

export async function getAiModelStatus(): Promise<AiModelStatus> {
  if (!isTauriRuntime()) return browserModelStatus;
  return invoke<AiModelStatus>("get_ai_model_status");
}

export async function getAiAnalysisStatus(): Promise<AiAnalysisProgress> {
  if (!isTauriRuntime()) return browserProgress;
  return invoke<AiAnalysisProgress>("get_ai_analysis_status");
}

export async function startAiAnalysis(
  mediaIds: string[] | undefined,
  analysisLevel: AiAnalysisLevel = "standard",
  scope?: AiAnalysisScope,
  totalItemsHint?: number,
): Promise<AiJobStart> {
  if (!isTauriRuntime()) {
    throw new Error("AI分析はインストール版のデスクトップアプリで利用できます");
  }
  return invoke<AiJobStart>("start_ai_analysis", {
    mediaIds,
    analysisLevel,
    scope,
    totalItemsHint,
  });
}

export async function previewAiAnalysisScope(
  scope: AiAnalysisScope,
): Promise<AiAnalysisScopePreview> {
  if (!isTauriRuntime()) return { analyzableItems: 0 };
  return invoke<AiAnalysisScopePreview>("preview_ai_analysis_scope", { scope });
}

export async function cancelAiAnalysis(jobId?: string): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("cancel_ai_analysis", { jobId });
}

export async function setAiAnalysisPaused(
  paused: boolean,
  jobId?: string,
): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("set_ai_analysis_paused", { paused, jobId });
}

export async function sampleSystemLoad(): Promise<SystemLoadSample> {
  if (!isTauriRuntime()) {
    return {
      timestampMs: Date.now(),
      cpuPercent: null,
      memoryPercent: null,
      usedMemoryBytes: 0,
      totalMemoryBytes: 0,
    };
  }
  return invoke<SystemLoadSample>("sample_system_load");
}

export async function listenToAiAnalysis(
  onProgress: (progress: AiAnalysisProgress) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => undefined;
  return listen<AiAnalysisProgress>(AI_ANALYSIS_PROGRESS_EVENT, (event) => {
    onProgress(event.payload);
  });
}

export function isAiAnalysisActive(phase: AiAnalysisPhase): boolean {
  return !["idle", "completed", "cancelled", "failed"].includes(phase);
}
