import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "../services/native";

/** Native Tauri fullscreen removes window chrome/taskbar, not just viewer menus. */
export function useViewerFullscreen(shell: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  const queue = useRef(Promise.resolve());
  const initial = useRef<boolean | undefined>(undefined);
  const mounted = useRef(true);
  const changed = useRef(false);
  const placement = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
  } | undefined>(undefined);
  const restorePlacement = async () => {
    const saved = placement.current;
    if (!saved) return;
    const window = getCurrentWindow();
    if (saved.maximized) {
      await window.maximize();
    } else {
      if (await window.isMaximized()) await window.unmaximize();
      await window.setSize(new PhysicalSize(saved.width, saved.height));
      await window.setPosition(new PhysicalPosition(saved.x, saved.y));
    }
    placement.current = undefined;
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const element = shell.current;
    let stop: (() => void) | undefined;
    const sync = async () => {
      const value = isTauriRuntime()
        ? await getCurrentWindow().isFullscreen()
        : document.fullscreenElement === element;
      if (initial.current === undefined) initial.current = value;
      if (active) setFullscreen(value);
    };
    if (isTauriRuntime()) {
      queue.current = queue.current.then(sync).catch(() => undefined);
      void getCurrentWindow().onResized(() => { void sync().catch(() => undefined); }).then((unlisten) => {
        if (!active) unlisten(); else stop = unlisten;
      }).catch(() => undefined);
    } else {
      document.addEventListener("fullscreenchange", sync);
      void sync();
      stop = () => document.removeEventListener("fullscreenchange", sync);
    }
    return () => {
      mounted.current = false;
      active = false;
      stop?.();
      if (isTauriRuntime()) {
        queue.current = queue.current.then(async () => {
          if (changed.current) {
            await getCurrentWindow().setFullscreen(initial.current ?? false);
            if (!(initial.current ?? false)) await restorePlacement();
          }
        }).catch(() => undefined);
      } else if (document.fullscreenElement === element) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [shell]);

  const changeFullscreen = useCallback((enabled?: boolean): Promise<void> => {
    if (isTauriRuntime()) {
      const operation = queue.current.then(async () => {
        if (!mounted.current) return;
        const window = getCurrentWindow();
        const current = await window.isFullscreen();
        if (initial.current === undefined) initial.current = current;
        const next = enabled ?? !current;
        if (next && !current) {
          const [position, size, maximized] = await Promise.all([
            window.outerPosition(),
            window.outerSize(),
            window.isMaximized(),
          ]);
          placement.current = {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized,
          };
        }
        await window.setFullscreen(next);
        if (!next && current) await restorePlacement();
        changed.current = true;
        if (mounted.current) setFullscreen(next);
      });
      queue.current = operation.catch(() => undefined);
      return operation;
    }
    const next = enabled ?? document.fullscreenElement !== shell.current;
    if (!next) return document.fullscreenElement ? document.exitFullscreen() : Promise.resolve();
    return shell.current?.requestFullscreen() ?? Promise.reject(new Error("全画面表示を開始できませんでした。"));
  }, [shell]);
  return { isFullscreen: fullscreen, changeFullscreen };
}
