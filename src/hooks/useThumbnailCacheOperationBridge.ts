import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { isTauriRuntime } from "../services/native";
import { reportOperation } from "../services/operations";

type ThumbnailCacheProgress = {
  phase: "running" | "completed" | "failed" | "cancelled";
  message: string;
  current: number;
  total: number;
};

const THUMBNAIL_OPERATION_ID = "thumbnail-cache";
const THUMBNAIL_PROGRESS_EVENT = "thumbnail-precache-progress";

export function useThumbnailCacheOperationBridge(): void {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let removeListener: (() => void) | undefined;

    const receive = (progress: ThumbnailCacheProgress) => {
      if (disposed) return;
      const percent =
        progress.total > 0
          ? Math.min(100, Math.round((progress.current / progress.total) * 100))
          : null;
      reportOperation({
        id: THUMBNAIL_OPERATION_ID,
        label: "サムネイルを準備",
        detail: progress.message,
        progress: percent,
        status:
          progress.phase === "completed"
            ? "success"
            : progress.phase === "failed"
              ? "error"
              : progress.phase === "cancelled"
                ? "cancelled"
              : "running",
      });
    };

    void listen<ThumbnailCacheProgress>(THUMBNAIL_PROGRESS_EVENT, (event) => {
      receive(event.payload);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else {
          removeListener = unlisten;
          void invoke<ThumbnailCacheProgress | null>("get_thumbnail_precache_status")
            .then((current) => {
              if (current) receive(current);
            })
            .catch(() => {
              // Live events continue even when the status snapshot is unavailable.
            });
        }
      })
      .catch(() => {
        // Thumbnail generation still runs if the optional progress listener
        // cannot be attached.
      });

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, []);
}
