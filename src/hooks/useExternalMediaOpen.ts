import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  isTauriRuntime,
  takePendingExternalMedia,
  type ExternalMediaOpenBatch,
} from "../services/native";

export const EXTERNAL_MEDIA_OPEN_EVENT = "pixvault://external-media-open";

type UseExternalMediaOpenOptions = {
  enabled: boolean;
  onOpen: (batch: ExternalMediaOpenBatch) => void;
  onError: (message: string) => void;
};

const MAX_REMEMBERED_REQUESTS = 64;

/**
 * Opens file-association and command-line media requests in the running app.
 *
 * The native event is intentionally only a wake-up signal. The durable native
 * queue remains the source of truth, which covers events sent while React is
 * mounting and notifications received while a previous take is still running.
 */
export function useExternalMediaOpen({
  enabled,
  onOpen,
  onError,
}: UseExternalMediaOpenOptions): void {
  const onOpenRef = useRef(onOpen);
  const onErrorRef = useRef(onError);
  onOpenRef.current = onOpen;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled || !isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let draining = false;
    let drainAgain = false;
    const handledRequestIds = new Set<string>();

    const rememberRequest = (requestId: string) => {
      handledRequestIds.add(requestId);
      if (handledRequestIds.size <= MAX_REMEMBERED_REQUESTS) return;
      const oldest = handledRequestIds.values().next().value;
      if (oldest !== undefined) handledRequestIds.delete(oldest);
    };

    const deliver = (batch: ExternalMediaOpenBatch | null) => {
      if (!batch || batch.items.length === 0 || handledRequestIds.has(batch.requestId)) return;
      rememberRequest(batch.requestId);
      const currentId = batch.items.some((item) => item.id === batch.currentId)
        ? batch.currentId
        : batch.items[0].id;
      onOpenRef.current(currentId === batch.currentId ? batch : { ...batch, currentId });
    };

    const drain = () => {
      if (disposed) return;
      if (draining) {
        drainAgain = true;
        return;
      }
      draining = true;
      void (async () => {
        try {
          do {
            drainAgain = false;
            const result = await takePendingExternalMedia();
            if (disposed) return;
            if (result.error) {
              onErrorRef.current(result.error);
            } else {
              deliver(result.data);
            }
          } while (!disposed && drainAgain);
        } catch (cause) {
          if (!disposed) {
            onErrorRef.current(
              cause instanceof Error
                ? cause.message
                : "外部ファイルをPixVaultで開けませんでした。",
            );
          }
        } finally {
          draining = false;
          // An event can arrive after the loop condition but before the async
          // task settles. Re-enter once so that wake-up is not lost.
          if (!disposed && drainAgain) drain();
        }
      })();
    };

    void listen<unknown>(EXTERNAL_MEDIA_OPEN_EVENT, () => drain())
      .then((stop) => {
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        // Subscribe before taking the startup queue. A second-instance event
        // emitted around this point then either starts or re-runs the drain.
        drain();
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        onErrorRef.current(
          cause instanceof Error
            ? cause.message
            : "外部ファイルを受け取る準備ができませんでした。",
        );
        // Startup arguments are still useful even if live event subscription
        // is unavailable for this session.
        drain();
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);
}
