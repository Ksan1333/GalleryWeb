import { invoke } from "@tauri-apps/api/core";

const SIGNAL_INTERVAL_MS = 750;

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Sends a deliberately low-frequency hint to native maintenance workers.
 * Pointer and scroll events stay entirely local; at most one IPC is emitted
 * per interval while the user is actively operating the application.
 */
export function installForegroundActivitySignals(): () => void {
  if (!isDesktopRuntime()) return () => undefined;

  let lastSignalAt = -SIGNAL_INTERVAL_MS;
  let requestInFlight = false;
  const signal = () => {
    const now = performance.now();
    if (requestInFlight || now - lastSignalAt < SIGNAL_INTERVAL_MS) return;
    lastSignalAt = now;
    requestInFlight = true;
    void invoke<void>("notify_foreground_activity")
      .catch(() => undefined)
      .finally(() => { requestInFlight = false; });
  };

  const passiveCapture: AddEventListenerOptions = { capture: true, passive: true };
  window.addEventListener("pointerdown", signal, passiveCapture);
  window.addEventListener("wheel", signal, passiveCapture);
  window.addEventListener("scroll", signal, passiveCapture);
  window.addEventListener("keydown", signal, true);
  window.addEventListener("focus", signal);
  signal();

  return () => {
    window.removeEventListener("pointerdown", signal, passiveCapture);
    window.removeEventListener("wheel", signal, passiveCapture);
    window.removeEventListener("scroll", signal, passiveCapture);
    window.removeEventListener("keydown", signal, true);
    window.removeEventListener("focus", signal);
  };
}
