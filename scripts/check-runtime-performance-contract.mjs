import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(projectRoot, path), "utf8");

const app = read("src/App.tsx");
const collection = read("src/components/MediaCollection.tsx");
const viewer = read("src/components/MediaViewer.tsx");
const videoSettings = read("src/components/VideoViewerSettings.tsx");
const viewerCss = read("src/components/MediaViewer.css");
const thumbnails = read("src/services/thumbnailCoordinator.ts");
const nativeBridge = read("src/services/native.ts");
const runtime = read("src/runtime.ts");
const native = read("src-tauri/src/lib.rs");
const watcher = read("src-tauri/src/folder_watcher.rs");

const checks = [
  [!app.includes('from "./releaseNotes"'), "release notes stay out of the startup bundle"],
  [app.includes("const ReleaseHistory = lazy("), "release history is loaded only on demand"],
  [app.includes("scheduleDeferredUi") && app.includes("backgroundUiReady"), "ancillary startup UI waits for an idle period"],
  [!app.includes("key={`images:${catalogRefreshVersion}`"), "watch updates do not remount the image folder browser"],
  [app.includes("const publishCatalogChange = useCallback") && app.includes('aria-label="すべてのフォルダーを再スキャン"') && app.includes("onClick={() => void scan()}"), "manual library refresh rescans folders and publishes a catalog change"],
  [nativeBridge.includes("appVersion: APP_VERSION") && runtime.includes("appVersion: APP_VERSION"), "renderer fallback version follows package metadata"],
  [collection.includes("const MEDIA_PAGE_SIZE = 64"), "gallery IPC pages cover a compact visible range"],
  [collection.includes("viewerIncludesAllMedia") && viewer.includes("ensureCollectionRange") && viewer.includes("VIEWER_COLLECTION_CACHE_MAX_ITEMS = 1_280"), "all-media viewer rail pages the complete gallery without retaining the whole catalog"],
  [collection.includes("scheduleRetry") && collection.includes("MEDIA_PAGE_SHORT_RESULT_RELOAD_ATTEMPTS"), "missing gallery pages retry and resynchronize instead of remaining blank"],
  [collection.includes("pagesToRevalidate") && collection.includes("if (!quiet)"), "quiet catalog refresh keeps stale pages and scroll position while revalidating"],
  [collection.includes("onPointerEnter") && collection.includes("animationRequested"), "gallery GIF animation is interaction-driven"],
  [thumbnails.includes("const queuedEntries = new Map"), "thumbnail lookup selects from an indexed queue"],
  [!thumbnails.includes("new Image()"), "thumbnail coordinator does not duplicate DOM image decoding"],
  [viewer.includes("MAX_PDF_PAGE_DISPLAY_CACHE_ENTRIES = 48"), "PDF display Blob cache is bounded"],
  [viewer.includes("waitForBookCacheIdle") && viewer.includes("BOOK_PAGE_CACHE_LOOK_AHEAD"), "book prefetch is idle and windowed"],
  [viewer.includes("BOOK_SEEK_PREVIEW_DEBOUNCE_MS") && viewer.includes("cachedPreview"), "book seek preview renders only after a short debounce while cache hits stay immediate"],
  [viewer.includes("getCachedArchivePageSource(item.id, item.modifiedAt"), "archive page source cache is content-versioned"],
  [!viewer.includes("Array.from({ length: pageCount }"), "opening a book does not eagerly render every page"],
  [/\.pv-viewer-backdrop\s*\{[^}]*background:\s*#050308;[^}]*\}/s.test(viewerCss), "viewer backdrop is opaque"],
  [!/\.pv-viewer-backdrop\s*\{[^}]*backdrop-filter/s.test(viewerCss), "viewer backdrop avoids full-window blur"],
  [!native.includes("schedule_media_maintenance(&app.handle()"), "startup does not automatically scan every thumbnail and vector"],
  [native.includes("schedule_startup_diagnostics"), "database integrity diagnostics run after startup"],
  [watcher.includes("RecommendedWatcher"), "folder monitoring is filesystem-event driven"],
  [native.includes("schedule_startup_missing_recovery") && native.includes("Err(_) => Some(true)"), "transient drive errors cannot permanently hide a large library"],
  [viewer.includes("if (nextItem) changeActive(nextItem.id, nextCollectionIndex)") && viewer.includes("if (!nextItem) onClose()"), "recycling from the viewer advances without closing when another media item exists"],
  [videoSettings.includes("volume: 0.5") && viewer.includes("VIDEO_PLAYBACK_PREFERENCE_KEY") && !viewer.includes("setVolume(1)"), "video volume is persisted and restored instead of resetting to full volume"],
];

let failed = false;
console.log("Runtime performance contracts:");
for (const [passed, description] of checks) {
  console.log(`  ${passed ? "PASS" : "FAIL"} ${description}`);
  if (!passed) failed = true;
}
if (failed) process.exitCode = 1;
