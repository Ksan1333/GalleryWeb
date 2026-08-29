import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

type Point = { x: number; y: number };

type FloatingPanelOptions = {
  storageKey: string;
  defaultLeft?: number;
  edgePadding?: number;
  layoutKey?: unknown;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
};

function storedPoint(storageKey: string): Point | undefined {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<Point> | null;
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return { x: Number(parsed.x), y: Number(parsed.y) };
    }
  } catch {
    // A malformed preference must not prevent the panel from opening.
  }
  return undefined;
}

function clampPoint(element: HTMLElement, point: Point, edgePadding: number): Point {
  const maxX = Math.max(edgePadding, window.innerWidth - element.offsetWidth - edgePadding);
  const maxY = Math.max(edgePadding, window.innerHeight - element.offsetHeight - edgePadding);
  return {
    x: Math.min(maxX, Math.max(edgePadding, point.x)),
    y: Math.min(maxY, Math.max(edgePadding, point.y)),
  };
}

export function useFloatingPanel<T extends HTMLElement>({
  storageKey,
  defaultLeft = 268,
  edgePadding = 16,
  layoutKey,
}: FloatingPanelOptions): {
  panelRef: RefObject<T | null>;
  floatingStyle: CSSProperties;
  onDragPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
} {
  const panelRef = useRef<T>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const [position, setPosition] = useState<Point>();

  const storePosition = useCallback((next: Point) => {
    setPosition(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Preferences are an enhancement; dragging still works without storage.
    }
  }, [storageKey]);

  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const saved = storedPoint(storageKey);
    const initial = saved ?? {
      x: defaultLeft,
      y: window.innerHeight - element.offsetHeight - edgePadding,
    };
    setPosition(clampPoint(element, initial, edgePadding));
  }, [defaultLeft, edgePadding, layoutKey, storageKey]);

  useEffect(() => {
    const element = panelRef.current;
    if (!element || !position) return;
    const handleResize = () => {
      const next = clampPoint(element, position, edgePadding);
      if (next.x !== position.x || next.y !== position.y) storePosition(next);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [edgePadding, position, storePosition]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const element = panelRef.current;
      if (!drag || !element || event.pointerId !== drag.pointerId) return;
      const next = clampPoint(element, {
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      }, edgePadding);
      setPosition(next);
    };
    const finishDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = undefined;
      document.documentElement.classList.remove("is-dragging-floating-panel");
      setPosition((current) => {
        if (!current) return current;
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(current));
        } catch {
          // Ignore unavailable preference storage.
        }
        return current;
      });
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      document.documentElement.classList.remove("is-dragging-floating-panel");
    };
  }, [edgePadding, storageKey]);

  const onDragPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const interactive = (event.target as HTMLElement).closest(
      "button, a, input, textarea, select, [role='button']",
    );
    if (interactive) return;
    const element = panelRef.current;
    if (!element) return;
    const current = position ?? clampPoint(element, {
      x: defaultLeft,
      y: window.innerHeight - element.offsetHeight - edgePadding,
    }, edgePadding);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: current,
    };
    document.documentElement.classList.add("is-dragging-floating-panel");
    event.preventDefault();
  }, [defaultLeft, edgePadding, position]);

  return {
    panelRef,
    floatingStyle: position
      ? { left: position.x, top: position.y, right: "auto", bottom: "auto" }
      : {},
    onDragPointerDown,
  };
}
