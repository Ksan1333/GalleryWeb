export const openAiAnalysisPanelEvent = "pixvault:open-ai-analysis-panel";

export type AiAnalysisPanelRequest = {
  rootId?: string;
  folderPath?: string;
  /** Opened from a folder gallery: analyze only files directly in that folder. */
  currentFolderOnly?: boolean;
};

export function openAiAnalysisPanel(request: AiAnalysisPanelRequest = {}): void {
  window.dispatchEvent(new CustomEvent<AiAnalysisPanelRequest>(
    openAiAnalysisPanelEvent,
    { detail: request },
  ));
}
