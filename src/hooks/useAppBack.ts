import { useEffect, useRef } from "react";

/**
 * Gives the top-level mouse-back coordinator a modal-aware close action.
 * Callers stay mounted while inactive, so registration follows the `active`
 * flag and the latest close callback is used without reordering listeners.
 */
export function useAppBack(active: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    if (!active) return;
    const handleNavigateBack = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{ handled?: boolean }>;
      if (event.defaultPrevented || event.detail?.handled) return;
      if (event.detail) event.detail.handled = true;
      event.preventDefault();
      onBackRef.current();
    };
    window.addEventListener("pixvault:navigate-back", handleNavigateBack);
    return () => window.removeEventListener("pixvault:navigate-back", handleNavigateBack);
  }, [active]);
}
