import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  getArchiveCover,
  getMediaImagePreview,
  getMediaPageInfo,
  invalidateMediaCatalogCache,
  invalidateMediaQueryCache,
  isTauriRuntime,
  listLibraryRoots,
  listMediaFolders,
  listMediaItems,
  localAssetUrl,
  mediaAssetUrl,
  openLibraryFolderInExplorer,
  patchFavoriteQueryCacheBatch,
  recycleMediaItem,
  reportMediaLoadFailure,
  saveMediaThumbnail,
  setAgeRating,
  setFavorite,
  setMediaTags,
  type AgeRating,
  type LibraryRoot,
  type MediaFolder,
  type MediaItem,
  type MediaKind,
  type MediaPageInfo,
  type MediaQuery,
} from "../services/native";
import {
  prefetchThumbnails,
  seedCoordinatedThumbnail,
  useCoordinatedThumbnail,
  type ThumbnailPrefetchTarget,
  type ThumbnailPriority,
} from "../services/thumbnailCoordinator";
import { useTagTranslations } from "../services/tagTranslations";
import { markFirstMediaCard, markFirstMediaThumbnail } from "../services/performance";
import {
  folderActivityKey,
  readFolderNavigation,
  recordFolderVisit,
  rememberFolderNavigation,
  setFolderFavorite,
  type FolderActivityInput,
  type FolderNavigationState,
  type FolderNavigationKey,
} from "../services/folderActivity";
import { useFolderActivity } from "../hooks/useFolderActivity";
import type { TagGalleryNavigationRequest } from "../services/galleryNavigation";
import { Icon } from "./Icon";
import {
  loadGallerySearchHistory,
  rememberGallerySearch,
  removeGallerySearchHistory,
  searchAndGroupingPreferencesEvent,
  type GallerySearchHistoryEntry,
} from "../services/gallerySearchHistory";
import {
  BulkMediaEditor,
  type BulkMediaEditRequest,
} from "./BulkMediaEditor";
import { startOperation } from "../services/operations";
import {
  EMPTY_GALLERY_SEARCH_FILTERS,
  GallerySearchModal,
  gallerySearchMediaKinds,
  gallerySearchModifiedRange,
  hasGallerySearchFilters,
  type GallerySearchFilters,
  type GallerySearchMediaFormat,
} from "./GallerySearchModal";
import { openAiAnalysisPanel } from "../services/aiPanel";
import {
  defaultGalleryDisplayPreferences,
  galleryGroupOptions,
  galleryDisplayPreferencesEvent,
  loadGalleryDisplayPreferences,
  mergeGalleryDisplayPreferences,
  normalizeGalleryDisplayPreferences,
  saveGalleryDisplayPreferences,
  type GalleryDisplayPreferences,
  type GalleryGridSize,
  type GalleryGroupMode,
  type GallerySortOrder,
} from "./GalleryDisplaySettings";
import {
  EmptyState,
  LoadingPanel,
  NativePreviewNotice,
  PageHeader,
  SelectMenu,
  StatusPanel,
  formatBytes,
  formatDate,
  formatDuration,
} from "./Ui";

type FavoriteKindFilter = MediaKind | "book" | "";

type MediaCollectionProps = {
  eyebrow: string;
  title: string;
  description: string;
  kinds?: MediaKind[];
  favoritesOnly?: boolean;
  showFavoriteKindFilter?: boolean;
  advancedGallerySearch?: boolean;
  viewerIncludesAllMedia?: boolean;
  emptyTitle: string;
  emptyDescription: string;
  initialSearch?: string;
  initialRootId?: string;
  initialFolderPath?: string;
  embedded?: boolean;
  compactFileLayout?: boolean;
  onBack?: () => void;
  onNavigateFolderPath?: (path: string | undefined) => void;
  leadingFolders?: FolderGroup[];
  onOpenLeadingFolder?: (folder: FolderGroup) => void;
  favoriteFolderKeys?: ReadonlySet<string>;
  onToggleLeadingFolderFavorite?: (folder: FolderGroup) => void;
  onAddFolder?: () => void;
  onDataChanged?: () => void;
  tagNavigation?: TagGalleryNavigationRequest;
  refreshVersion?: number;
};

type GalleryContextMenuState = {
  x: number;
  y: number;
  item?: MediaItem;
};

type RangeSelectionProgress = {
  selected: number;
  total: number;
};

type FolderGroup = {
  key: string;
  rootId: string;
  relativeFolder: string;
  name: string;
  displayPath: string;
  itemCount: number;
  hasChildren: boolean;
};

async function browserCompatibleImageBlob(item: MediaItem): Promise<Blob> {
  const decode = async (source: string): Promise<Blob> => {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`画像を読み込めませんでした（${response.status}）`);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const maxEdge = 4_096;
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("画像をコピー用に変換できませんでした。");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("PNG画像を作成できませんでした。")),
          "image/png",
        );
      });
    } finally {
      bitmap.close();
    }
  };

  const directSource = mediaAssetUrl(item);
  if (directSource) {
    try {
      return await decode(directSource);
    } catch {
      // Fall through to the native browser-compatible preview.
    }
  }
  const preview = await getMediaImagePreview(item.id);
  const previewSource = localAssetUrl(preview.data ?? undefined);
  if (!previewSource) throw new Error(preview.error ?? "この画像形式をコピーできませんでした。");
  return decode(previewSource);
}

type FolderMediaCollectionProps = Omit<MediaCollectionProps, "initialRootId" | "initialFolderPath" | "onBack" | "showFavoriteKindFilter" | "favoritesOnly"> & {
  navigationKey: FolderNavigationKey;
};

const MediaViewer = lazy(() => import("./MediaViewer").then((module) => ({ default: module.MediaViewer })));

async function openFolderInExplorer(
  root: LibraryRoot | undefined,
  relativePath: string | undefined,
  onError: (message: string) => void,
) {
  if (!root) {
    onError("開くフォルダーが見つかりませんでした。");
    return;
  }
  if (!isTauriRuntime()) {
    onError("エクスプローラーはインストール版アプリから開けます。");
    return;
  }
  const result = await openLibraryFolderInExplorer(root.id, relativePath ?? "");
  if (!result.data || result.error) {
    onError(result.error ?? "エクスプローラーを開けませんでした。");
  }
}

const favoriteKindOptions: Array<{ value: FavoriteKindFilter; label: string }> = [
  { value: "", label: "すべて" },
  { value: "image", label: "画像" },
  { value: "gif", label: "GIF" },
  { value: "video", label: "動画" },
  { value: "book", label: "ブック" },
];

// Scroll motion is intentionally kept outside MediaCollection state. Updating
// the full collection just to suspend an animated GIF would defeat the row
// virtualization below; only GIF visuals subscribe to this tiny store.
let galleryScrollActive = false;
let galleryViewerActive = false;
const galleryScrollListeners = new Set<() => void>();

function setGalleryScrollActive(active: boolean) {
  if (galleryScrollActive === active) return;
  galleryScrollActive = active;
  galleryScrollListeners.forEach((listener) => listener());
}

function setGalleryViewerActive(active: boolean) {
  if (galleryViewerActive === active) return;
  galleryViewerActive = active;
  galleryScrollListeners.forEach((listener) => listener());
}

function useGalleryScrollActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      galleryScrollListeners.add(listener);
      return () => galleryScrollListeners.delete(listener);
    },
    () => galleryScrollActive || galleryViewerActive,
    () => false,
  );
}

function mediaKindLabel(kind: MediaKind): string {
  switch (kind) {
    case "image": return "画像";
    case "gif": return "GIF";
    case "video": return "動画";
    case "pdf":
    case "archive": return "本";
    case "document": return "文書";
    default: return "ファイル";
  }
}

function createThumbnailDataUrl(element: HTMLImageElement | HTMLVideoElement): string | undefined {
  const sourceWidth = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
  const sourceHeight = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
  if (!sourceWidth || !sourceHeight) return undefined;
  const maxEdge = 480;
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(element, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

type ThumbnailCaptureJob = {
  cancelled: boolean;
  run: () => void;
};

const thumbnailCaptureQueue: ThumbnailCaptureJob[] = [];
let thumbnailCaptureScheduled = false;

function pumpThumbnailCaptureQueue() {
  if (thumbnailCaptureScheduled) return;
  while (thumbnailCaptureQueue[0]?.cancelled) thumbnailCaptureQueue.shift();
  const job = thumbnailCaptureQueue.shift();
  if (!job) return;
  thumbnailCaptureScheduled = true;
  const execute = () => {
    if (!job.cancelled) job.run();
    window.setTimeout(() => {
      thumbnailCaptureScheduled = false;
      pumpThumbnailCaptureQueue();
    }, 24);
  };
  const requestIdle = (window as typeof window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (requestIdle) requestIdle(execute, { timeout: 1_200 });
  else window.setTimeout(execute, 48);
}

function queueThumbnailCapture(run: () => void): () => void {
  const job: ThumbnailCaptureJob = { cancelled: false, run };
  thumbnailCaptureQueue.push(job);
  pumpThumbnailCaptureQueue();
  return () => { job.cancelled = true; };
}

type MediaDecodeJob = {
  cancelled: boolean;
  started: boolean;
  run: (finish: () => void) => void;
  finish?: () => void;
};

const MEDIA_DECODE_CONCURRENCY = Math.max(
  1,
  Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
);
const mediaDecodeQueue: MediaDecodeJob[] = [];
let activeMediaDecodes = 0;

function pumpMediaDecodeQueue() {
  while (activeMediaDecodes < MEDIA_DECODE_CONCURRENCY && mediaDecodeQueue.length > 0) {
    const job = mediaDecodeQueue.shift();
    if (!job || job.cancelled) continue;
    job.started = true;
    activeMediaDecodes += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeMediaDecodes = Math.max(0, activeMediaDecodes - 1);
      queueMicrotask(pumpMediaDecodeQueue);
    };
    job.finish = finish;
    try {
      job.run(finish);
    } catch {
      finish();
    }
  }
}

function queueMediaDecode(run: (finish: () => void) => void): () => void {
  const job: MediaDecodeJob = { cancelled: false, started: false, run };
  mediaDecodeQueue.push(job);
  pumpMediaDecodeQueue();
  return () => {
    job.cancelled = true;
    if (job.started) job.finish?.();
  };
}

function useCachedThumbnail(item: MediaItem, priority: ThumbnailPriority = "visible") {
  const thumbnail = useCoordinatedThumbnail(
    item.id,
    item.modifiedAt,
    item.thumbnailPath,
    priority,
  );
  const cachedPath = item.thumbnailPath ?? thumbnail.path;
  const saving = useRef(false);
  const cancelCapture = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    saving.current = false;
    cancelCapture.current?.();
    cancelCapture.current = undefined;
    return () => {
      cancelCapture.current?.();
      cancelCapture.current = undefined;
    };
  }, [item.id, item.modifiedAt]);

  const cacheElement = useCallback((element: HTMLImageElement | HTMLVideoElement) => {
    if (saving.current || cachedPath) return;
    saving.current = true;
    cancelCapture.current?.();
    cancelCapture.current = queueThumbnailCapture(() => {
      cancelCapture.current = undefined;
      let dataUrl: string | undefined;
      try {
        dataUrl = createThumbnailDataUrl(element);
      } catch {
        saving.current = false;
        return;
      }
      if (!dataUrl) {
        saving.current = false;
        return;
      }
      void saveMediaThumbnail(item.id, dataUrl).then((result) => {
        if (result.data) {
          seedCoordinatedThumbnail(item.id, item.modifiedAt, result.data);
        } else saving.current = false;
      }).catch(() => { saving.current = false; });
    });
  }, [cachedPath, item.id, item.modifiedAt]);

  const cacheDataUrl = useCallback((dataUrl: string) => {
    if (saving.current || cachedPath) return;
    saving.current = true;
    void saveMediaThumbnail(item.id, dataUrl).then((result) => {
      if (result.data) {
        seedCoordinatedThumbnail(item.id, item.modifiedAt, result.data);
      } else saving.current = false;
    });
  }, [cachedPath, item.id, item.modifiedAt]);

  return {
    cachedSource: localAssetUrl(cachedPath),
    lookupPending: !cachedPath && thumbnail.pending,
    cacheElement,
    cacheDataUrl,
  };
}

function useArchiveCover(item: MediaItem): { source?: string; pending: boolean } {
  const [coverPath, setCoverPath] = useState<string>();
  const [pending, setPending] = useState(item.kind === "archive");
  useEffect(() => {
    if (item.kind !== "archive") {
      setCoverPath(undefined);
      setPending(false);
      return;
    }
    let active = true;
    setPending(true);
    void getArchiveCover(item.id).then((result) => {
      if (!active) return;
      setCoverPath(result.data ?? undefined);
      setPending(false);
    }).catch(() => {
      if (active) setPending(false);
    });
    return () => { active = false; };
  }, [item.id, item.kind]);
  return { source: localAssetUrl(coverPath), pending };
}

function VideoThumbnail({
  source,
  onFrameReady,
  onSourceError,
  onSettled,
}: {
  source: string;
  onFrameReady: (video: HTMLVideoElement) => void;
  onSourceError?: () => void;
  onSettled?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const targetTimeRef = useRef(0);
  const settledRef = useRef(false);
  const frameHandledRef = useRef(false);
  const settleFrame = useCallback((video: HTMLVideoElement) => {
    if (frameHandledRef.current) return;
    frameHandledRef.current = true;
    settledRef.current = true;
    onFrameReady(video);
  }, [onFrameReady]);

  useEffect(() => {
    settledRef.current = false;
    frameHandledRef.current = false;
    const timeout = window.setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      onSettled?.();
    }, 4_000);
    return () => window.clearTimeout(timeout);
  }, [onSettled, source]);

  if (failed) {
    return (
      <div className="media-placeholder kind-video" aria-hidden="true">
        <Icon name="video" />
        <span>VIDEO</span>
      </div>
    );
  }

  return (
    <video
      className="video-thumbnail"
      src={source}
      muted
      playsInline
      preload="metadata"
      crossOrigin="anonymous"
      aria-label=""
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        targetTimeRef.current = duration > 0.4 ? Math.min(1, duration * 0.12) : 0;
        if (targetTimeRef.current > 0) {
          try {
            video.currentTime = targetTimeRef.current;
          } catch {
            settleFrame(video);
          }
        }
      }}
      onLoadedData={(event) => {
        if (targetTimeRef.current <= 0) settleFrame(event.currentTarget);
      }}
      onSeeked={(event) => settleFrame(event.currentTarget)}
      onError={() => {
        settledRef.current = true;
        frameHandledRef.current = true;
        setFailed(true);
        if (onSourceError) onSourceError();
        else onSettled?.();
      }}
    />
  );
}

function SettledMediaPlaceholder({
  item,
  onSettled,
}: {
  item: MediaItem;
  onSettled?: () => void;
}) {
  useEffect(() => onSettled?.(), [onSettled]);
  return (
    <div className={`media-placeholder kind-${item.kind}`} aria-hidden="true">
      <Icon name={item.kind === "video" ? "video" : item.kind === "pdf" || item.kind === "archive" ? "book" : item.kind === "document" ? "file" : "image"} />
      <span>{item.kind === "pdf" ? "PDF" : item.kind === "archive" ? "ZIP / CBZ" : item.kind.toUpperCase()}</span>
    </div>
  );
}

function ArchiveMediaVisual({
  item,
  onImageLoaded,
  onSettled,
}: {
  item: MediaItem;
  onImageLoaded: (element: HTMLImageElement) => void;
  onSettled?: () => void;
}) {
  const archiveCover = useArchiveCover(item);
  if (archiveCover.pending) {
    return <div className="media-placeholder kind-archive" aria-hidden="true"><Icon name="book" /><span>ZIP / CBZ</span></div>;
  }
  if (archiveCover.source) {
    return (
      <img
        src={archiveCover.source}
        alt=""
        loading="eager"
        decoding="async"
        crossOrigin="anonymous"
        onLoad={(event) => onImageLoaded(event.currentTarget)}
        onError={onSettled}
      />
    );
  }
  return <SettledMediaPlaceholder item={item} onSettled={onSettled} />;
}

function CachedMediaVisual({
  item,
  onSettled,
  thumbnailPriority = "visible",
}: {
  item: MediaItem;
  onSettled?: () => void;
  thumbnailPriority?: ThumbnailPriority;
}) {
  const source = mediaAssetUrl(item);
  const { cachedSource, lookupPending, cacheElement, cacheDataUrl } = useCachedThumbnail(
    item,
    thumbnailPriority,
  );
  const handleImageLoaded = useCallback((element: HTMLImageElement) => {
    cacheElement(element);
    onSettled?.();
  }, [cacheElement, onSettled]);
  const handleVideoFrame = useCallback((element: HTMLVideoElement) => {
    cacheElement(element);
    onSettled?.();
  }, [cacheElement, onSettled]);
  const handlePdfRendered = useCallback((dataUrl: string) => {
    cacheDataUrl(dataUrl);
    onSettled?.();
  }, [cacheDataUrl, onSettled]);
  const handleSourceError = useCallback(() => {
    onSettled?.();
    void reportMediaLoadFailure(item.id);
  }, [item.id, onSettled]);

  if (lookupPending) {
    return <div className={`media-placeholder kind-${item.kind}`} aria-hidden="true"><Icon name={item.kind === "video" ? "video" : item.kind === "pdf" || item.kind === "archive" ? "book" : "image"} /></div>;
  }
  if (cachedSource) {
    return (
      <img
        src={cachedSource}
        alt=""
        loading={thumbnailPriority === "visible" ? "eager" : "lazy"}
        decoding="async"
        onLoad={onSettled}
        onError={handleSourceError}
      />
    );
  }

  if (item.kind === "archive") {
    return <ArchiveMediaVisual item={item} onImageLoaded={handleImageLoaded} onSettled={onSettled} />;
  }
  if (source && (item.kind === "image" || item.kind === "gif")) {
    return (
      <img
        src={source}
        alt=""
        loading={thumbnailPriority === "visible" ? "eager" : "lazy"}
        decoding="async"
        crossOrigin="anonymous"
        onLoad={(event) => handleImageLoaded(event.currentTarget)}
        onError={handleSourceError}
      />
    );
  }
  if (source && item.kind === "video") {
    return <VideoThumbnail source={source} onFrameReady={handleVideoFrame} onSourceError={handleSourceError} onSettled={onSettled} />;
  }
  if (source && item.kind === "pdf") {
    return <PdfThumbnail source={source} name={item.name} onRendered={handlePdfRendered} onSourceError={handleSourceError} onSettled={onSettled} />;
  }
  return <SettledMediaPlaceholder item={item} onSettled={onSettled} />;
}

function GifMediaVisual({
  item,
  onSettled,
  thumbnailPriority = "visible",
}: {
  item: MediaItem;
  onSettled?: () => void;
  thumbnailPriority?: ThumbnailPriority;
}) {
  const scrolling = useGalleryScrollActive();
  const [animationRequested, setAnimationRequested] = useState(false);
  const { cachedSource: thumbnailSource, lookupPending, cacheElement } = useCachedThumbnail(
    item,
    thumbnailPriority,
  );
  const handleAnimatedLoad = useCallback((element: HTMLImageElement) => {
    cacheElement(element);
    onSettled?.();
  }, [cacheElement, onSettled]);
  const handleSourceError = useCallback(() => {
    onSettled?.();
    void reportMediaLoadFailure(item.id);
  }, [item.id, onSettled]);

  useEffect(() => {
    if (!scrolling) return;
    setAnimationRequested(false);
    // Replacing a GIF that is still decoding removes its load event. Release
    // the shared decoder slot immediately so other visible stills can load.
    onSettled?.();
  }, [onSettled, scrolling]);

  const source = mediaAssetUrl(item);
  const showAnimation = animationRequested && !scrolling && Boolean(source);
  return (
    <span
      className="gif-media-visual"
      onPointerEnter={() => {
        if (!scrolling) setAnimationRequested(true);
      }}
      onPointerLeave={() => setAnimationRequested(false)}
    >
      {showAnimation ? (
        <img
          src={source}
          alt=""
          loading="eager"
          decoding="async"
          crossOrigin="anonymous"
          onLoad={(event) => handleAnimatedLoad(event.currentTarget)}
          onError={handleSourceError}
        />
      ) : thumbnailSource && !lookupPending ? (
        <img
          src={thumbnailSource}
          alt=""
          loading={thumbnailPriority === "visible" ? "eager" : "lazy"}
          decoding="async"
          onLoad={onSettled}
          onError={handleSourceError}
        />
      ) : <SettledMediaPlaceholder item={item} onSettled={onSettled} />}
    </span>
  );
}

export function MediaVisual({
  item,
  onSettled,
  thumbnailPriority = "visible",
}: {
  item: MediaItem;
  onSettled?: () => void;
  thumbnailPriority?: ThumbnailPriority;
}) {
  if (item.kind === "gif") {
    return <GifMediaVisual item={item} onSettled={onSettled} thumbnailPriority={thumbnailPriority} />;
  }
  return <CachedMediaVisual item={item} onSettled={onSettled} thumbnailPriority={thumbnailPriority} />;
}

function PdfThumbnail({
  source,
  name,
  onRendered,
  onSourceError,
  onSettled,
}: {
  source: string;
  name: string;
  onRendered: (dataUrl: string) => void;
  onSourceError?: () => void;
  onSettled?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let renderTask: RenderTask | undefined;
    void import("pdfjs-dist").then(async ({ GlobalWorkerOptions, getDocument }) => {
      if (!active) return;
      GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      loadingTask = getDocument({ url: source });
      const document = await loadingTask.promise;
      const page = await document.getPage(1);
      if (!active || !canvasRef.current) return;
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 480 / Math.max(1, natural.width));
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("PDF canvas is unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      await renderTask.promise;
      if (active) onRendered(canvas.toDataURL("image/jpeg", 0.82));
    }).catch(() => {
      if (!active) return;
      setFailed(true);
      if (onSourceError) onSourceError();
      else onSettled?.();
    });
    return () => {
      active = false;
      renderTask?.cancel();
      if (loadingTask) void loadingTask.destroy();
    };
  }, [onRendered, onSettled, onSourceError, source]);

  if (failed) return <div className="media-placeholder kind-pdf" aria-hidden="true"><Icon name="book" /><span>PDF</span></div>;
  return <canvas ref={canvasRef} className="pdf-canvas-thumbnail" role="img" aria-label={`${name}の表紙`} />;
}

const nearViewportCallbacks = new WeakMap<Element, () => void>();
let nearViewportObserver: IntersectionObserver | undefined;
function observeNearViewport(element: Element, onVisible: () => void): () => void {
  if (!("IntersectionObserver" in window)) {
    onVisible();
    return () => undefined;
  }
  nearViewportObserver ??= new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = nearViewportCallbacks.get(entry.target);
        observer.unobserve(entry.target);
        nearViewportCallbacks.delete(entry.target);
        callback?.();
      }
    },
    { rootMargin: "360px 0px" },
  );
  nearViewportCallbacks.set(element, onVisible);
  nearViewportObserver.observe(element);
  return () => {
    nearViewportObserver?.unobserve(element);
    nearViewportCallbacks.delete(element);
  };
}

function QueuedMediaVisual({
  item,
  onSettled,
  thumbnailPriority = "visible",
}: {
  item: MediaItem;
  onSettled?: () => void;
  thumbnailPriority?: ThumbnailPriority;
}) {
  const decodeKey = `${item.id}\u0000${item.modifiedAt ?? ""}`;
  const admissionKey = `${decodeKey}\u0000${thumbnailPriority}`;
  const [readyKey, setReadyKey] = useState<string>();
  const releaseRef = useRef<(() => void) | undefined>(undefined);
  const settle = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = undefined;
    onSettled?.();
  }, [onSettled]);

  useEffect(() => {
    let active = true;
    if (thumbnailPriority !== "visible") {
      releaseRef.current?.();
      releaseRef.current = undefined;
      setReadyKey(admissionKey);
      return () => { active = false; };
    }
    const cancel = queueMediaDecode((finish) => {
      if (!active) {
        finish();
        return;
      }
      releaseRef.current = finish;
      setReadyKey(admissionKey);
    });
    return () => {
      active = false;
      cancel();
      releaseRef.current = undefined;
    };
  }, [admissionKey, thumbnailPriority]);

  if (readyKey !== admissionKey) {
    return (
      <div className={`media-placeholder kind-${item.kind}`} aria-hidden="true">
        <Icon name={item.kind === "video" ? "video" : item.kind === "pdf" || item.kind === "archive" ? "book" : "image"} />
      </div>
    );
  }
  return <MediaVisual item={item} onSettled={settle} thumbnailPriority={thumbnailPriority} />;
}

export function LazyMediaVisual({
  item,
  onSettled,
  thumbnailPriority = "visible",
}: {
  item: MediaItem;
  onSettled?: () => void;
  thumbnailPriority?: ThumbnailPriority;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) return;
    return observeNearViewport(host, () => setVisible(true));
  }, [visible]);

  return (
    <div className="lazy-media-visual" ref={hostRef}>
      {visible
        ? <QueuedMediaVisual item={item} onSettled={onSettled} thumbnailPriority={thumbnailPriority} />
        : <div className={`media-placeholder kind-${item.kind}`} aria-hidden="true"><Icon name={item.kind === "video" ? "video" : item.kind === "pdf" || item.kind === "archive" ? "book" : "image"} /></div>}
    </div>
  );
}

function StyledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return <SelectMenu label={label} value={value} onChange={onChange} options={options} />;
}

// Smaller pages let a large gallery paint usable cards as soon as each query
// returns, instead of waiting for a 120-item metadata/tag batch.
const MEDIA_PAGE_SIZE = 64;
const MEDIA_PAGE_MEMORY_LIMIT = 8;
const MEDIA_PAGE_LOAD_CONCURRENCY = 2;
const MEDIA_PAGE_RETRY_BASE_MS = 300;
const MEDIA_PAGE_RETRY_MAX_MS = 4_800;
const MEDIA_PAGE_SHORT_RESULT_RELOAD_ATTEMPTS = 3;
const VIRTUAL_OVERSCAN_ROWS = 2;
const RANGE_SELECTION_BATCH_SIZE = 128;
const VIRTUAL_GAP = 14;
const DATE_HEADER_HEIGHT = 42;
const SCROLL_IDLE_MS = 150;

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runNext = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => runNext()),
  );
}

type GridMetrics = {
  columns: number;
  rowHeight: number;
  visualHeight: number;
};

type VirtualDateGroup = {
  date: string;
  itemCount: number;
  startIndex: number;
  top: number;
  rows: number;
  height: number;
  headerHeight: number;
};

type VirtualSlot = {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
};

function firstVisibleGroupIndex(groups: VirtualDateGroup[], viewportTop: number): number {
  let low = 0;
  let high = groups.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const group = groups[middle];
    if (group.top + group.height < viewportTop) low = middle + 1;
    else high = middle;
  }
  return low;
}

function quantizeScrollTop(
  scrollTop: number,
  rowHeight: number,
  groups: VirtualDateGroup[],
  leadingFolderHeight: number,
): number {
  const safeTop = Math.max(0, scrollTop);
  const safeRowHeight = Math.max(1, rowHeight);
  if (safeTop < leadingFolderHeight || groups.length === 0) {
    return Math.floor(safeTop / safeRowHeight) * safeRowHeight;
  }

  const group = groups[firstVisibleGroupIndex(groups, safeTop)];
  if (!group) return Math.floor(safeTop / safeRowHeight) * safeRowHeight;
  const rowsTop = group.top + group.headerHeight;
  if (safeTop < rowsTop) return group.top;
  return rowsTop + Math.floor((safeTop - rowsTop) / safeRowHeight) * safeRowHeight;
}

function addBoundedMediaPage(
  current: Map<number, MediaItem[]>,
  page: number,
  items: MediaItem[],
  anchorPage: number,
): Map<number, MediaItem[]> {
  const next = new Map(current);
  next.set(page, items);
  if (next.size <= MEDIA_PAGE_MEMORY_LIMIT) return next;

  const retained = new Set(
    [...next.keys()]
      .sort((left, right) =>
        Math.abs(left - anchorPage) - Math.abs(right - anchorPage) || left - right,
      )
      .slice(0, MEDIA_PAGE_MEMORY_LIMIT),
  );
  return new Map(
    [...next.entries()]
      .filter(([pageNumber]) => retained.has(pageNumber))
      .sort(([left], [right]) => left - right),
  );
}

function gridMetrics(size: GalleryGridSize, width: number, compactFileLayout = false): GridMetrics {
  if (compactFileLayout) {
    const targetCardWidth = 112;
    const columns = Math.max(1, Math.min(
      14,
      Math.floor((Math.max(width, targetCardWidth) + VIRTUAL_GAP) / (targetCardWidth + VIRTUAL_GAP)),
    ));
    const cardWidth = Math.max(
      1,
      (Math.max(width, targetCardWidth) - VIRTUAL_GAP * (columns - 1)) / columns,
    );
    const squareSize = Math.floor(cardWidth);
    return {
      columns,
      rowHeight: squareSize + VIRTUAL_GAP,
      visualHeight: Math.max(62, squareSize - 36),
    };
  }
  const targetColumns: Record<GalleryGridSize, number> = {
    minimum: 10,
    small: 7,
    medium: 5,
    large: 3,
    maximum: 2,
  };
  const minimumCardWidth: Record<GalleryGridSize, number> = {
    minimum: 72,
    small: 100,
    medium: 150,
    large: 220,
    maximum: 340,
  };
  const maximumColumns = targetColumns[size];
  const minimum = minimumCardWidth[size];
  const responsiveColumns = Math.max(
    1,
    Math.floor((Math.max(width, minimum) + VIRTUAL_GAP) / (minimum + VIRTUAL_GAP)),
  );
  const columns = Math.min(maximumColumns, responsiveColumns);
  const cardWidth = Math.max(
    1,
    (Math.max(width, minimum) - VIRTUAL_GAP * (columns - 1)) / columns,
  );
  const visualHeight = Math.floor(cardWidth);
  return {
    columns,
    rowHeight: visualHeight + (size === "minimum" ? VIRTUAL_GAP : size === "small" ? 78 : 88),
    visualHeight,
  };
}

function sortQuery(sortOrder: GallerySortOrder): Pick<MediaQuery, "sortBy" | "sortDirection"> {
  const [field, direction] = sortOrder.split("-") as [
    "modified" | "name" | "size",
    "asc" | "desc",
  ];
  return {
    sortBy: field === "modified" ? "modifiedAt" : field,
    sortDirection: direction,
  };
}

function buildVirtualGroups(
  pageInfo: MediaPageInfo,
  metrics: GridMetrics,
  groupMode: GalleryGroupMode,
): { groups: VirtualDateGroup[]; totalHeight: number } {
  if (pageInfo.totalCount === 0) return { groups: [], totalHeight: 0 };
  const grouped = new Map<string, number>();
  if (groupMode !== "none") {
    for (const group of pageInfo.dateGroups) {
      const date = groupMode === "year"
        ? group.date.slice(0, 4)
        : groupMode === "month"
          ? group.date.slice(0, 7)
          : group.date;
      grouped.set(date, (grouped.get(date) ?? 0) + group.itemCount);
    }
  }
  const source = groupMode !== "none" && grouped.size > 0
    ? [...grouped].map(([date, itemCount]) => ({ date, itemCount }))
    : [{ date: "", itemCount: pageInfo.totalCount }];
  let top = 0;
  let startIndex = 0;
  const groups = source.map((group) => {
    const rows = Math.ceil(group.itemCount / metrics.columns);
    const headerHeight = groupMode !== "none" ? DATE_HEADER_HEIGHT : 0;
    const height = headerHeight + rows * metrics.rowHeight;
    const layout: VirtualDateGroup = {
      date: group.date,
      itemCount: group.itemCount,
      startIndex,
      top,
      rows,
      height,
      headerHeight,
    };
    startIndex += group.itemCount;
    top += height;
    return layout;
  });
  return { groups, totalHeight: top };
}

function formatGroupDate(value: string, groupMode: GalleryGroupMode): string {
  const [year, month, day] = value.split("-");
  if (groupMode === "year") return year ? `${Number(year)}年` : value;
  if (groupMode === "month") {
    return year && month ? `${Number(year)}年${Number(month)}月` : value;
  }
  if (!year || !month || !day) return value;
  return `${Number(year)}年${Number(month)}月${Number(day)}日`;
}

function directChildFolders(
  folders: MediaFolder[],
  rootId: string,
  parentPath: string,
): FolderGroup[] {
  const prefix = parentPath ? `${parentPath}/` : "";
  const children = new Map<string, FolderGroup>();
  for (const folder of folders) {
    if (folder.rootId !== rootId || !folder.relativeFolder.startsWith(prefix)) continue;
    const remaining = folder.relativeFolder.slice(prefix.length);
    if (!remaining) continue;
    const [segment] = remaining.split("/");
    if (!segment) continue;
    const relativeFolder = `${prefix}${segment}`;
    const existing = children.get(relativeFolder);
    const hasChildren = folder.relativeFolder.slice(relativeFolder.length).startsWith("/");
    if (existing) {
      existing.itemCount += folder.itemCount;
      existing.hasChildren ||= hasChildren;
      continue;
    }
    children.set(relativeFolder, {
      key: `${rootId}:${relativeFolder}`,
      rootId,
      relativeFolder,
      name: segment,
      displayPath: relativeFolder,
      itemCount: folder.itemCount,
      hasChildren,
    });
  }
  return [...children.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "ja", { numeric: true }),
  );
}

function currentFolderItemCount(folders: MediaFolder[], path: string): number {
  return folders.find((folder) => folder.relativeFolder === path)?.itemCount ?? 0;
}

const MediaCard = memo(function MediaCard({
  item,
  itemIndex,
  gridSize,
  compactFileLayout,
  thumbnailPriority,
  working,
  selected,
  selectionAnchor,
  selectionMode,
  translateTag,
  onActivate,
  onToggleSelection,
  onFavorite,
  onRecycle,
  onContextMenu,
}: {
  item: MediaItem;
  itemIndex: number;
  gridSize: GalleryGridSize;
  compactFileLayout: boolean;
  thumbnailPriority: ThumbnailPriority;
  working: boolean;
  selected: boolean;
  selectionAnchor: boolean;
  selectionMode: boolean;
  translateTag: (tagName: string) => string;
  onActivate: (item: MediaItem, itemIndex: number, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onToggleSelection: (
    item: MediaItem,
    itemIndex: number,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  onFavorite: (item: MediaItem) => void;
  onRecycle: (item: MediaItem) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, item: MediaItem) => void;
}) {
  useEffect(markFirstMediaCard, []);
  return (
    <article
      className={[
        "media-card",
        "virtual-media-card",
        `size-${gridSize}`,
        compactFileLayout ? "is-compact-file" : "",
        selectionMode ? "is-selection-mode" : "",
        selected ? "is-selected" : "",
        selectionAnchor ? "is-selection-anchor" : "",
      ].filter(Boolean).join(" ")}
      role="listitem"
      onContextMenu={(event) => onContextMenu(event, item)}
    >
      {selectionMode && (
        <button
          className="media-selection-check"
          type="button"
          aria-label={selected ? `${item.name}の選択を解除` : `${item.name}を選択`}
          aria-pressed={selected}
          aria-keyshortcuts="Shift+Enter"
          title="Shift+クリックで範囲選択"
          onClick={(event) => onToggleSelection(item, itemIndex, event)}
        >
          {selected ? <Icon name="check" /> : <span />}
        </button>
      )}
      <button
        className="media-open"
        type="button"
        aria-label={selectionMode ? `${item.name}を${selected ? "選択解除" : "選択"}` : item.name}
        aria-pressed={selectionMode ? selected : undefined}
        aria-keyshortcuts="Shift+Enter"
        title={selectionMode ? "クリックで選択、Shift+クリックで範囲選択" : undefined}
        onClick={(event) => onActivate(item, itemIndex, event)}
      >
        <div className="media-visual">
          <LazyMediaVisual
            item={item}
            onSettled={markFirstMediaThumbnail}
            thumbnailPriority={thumbnailPriority}
          />
          <span className="media-type-label">{mediaKindLabel(item.kind)}</span>
          <span className={`age-rating-badge age-${item.ageRating.toLowerCase()}`}>
            {item.ageRating === "UNRATED" ? "未選択" : item.ageRating}
          </span>
          {item.durationSeconds && <span className="duration-badge">{formatDuration(item.durationSeconds)}</span>}
          {(item.pageCount || item.kind === "pdf" || item.kind === "archive") && (
            <span className="kind-badge">{item.pageCount ? `${item.pageCount}ページ` : item.kind.toUpperCase()}</span>
          )}
        </div>
        {(gridSize !== "minimum" || compactFileLayout) && (
          <div className="media-copy">
            <strong title={item.name}>{item.name}</strong>
            <span>{formatBytes(item.sizeBytes)} · {formatDate(item.modifiedAt)}</span>
            {gridSize !== "small" && item.tags.length > 0 && (
              <div className="media-tags">
                {item.tags.slice(0, 3).map((tag) => {
                  const translated = translateTag(tag.name);
                  const confidence = tag.source === "ai" && tag.confidence !== undefined
                    ? Math.max(0, Math.min(1, tag.confidence))
                    : undefined;
                  return (
                    <span
                      key={tag.id}
                      className={confidence !== undefined ? "is-ai-confidence" : undefined}
                      style={confidence !== undefined
                        ? { "--media-tag-confidence": `${Math.round(confidence * 100)}%` } as CSSProperties
                        : undefined}
                      title={translated !== tag.name ? tag.name : undefined}
                    >
                      {translated}
                      {confidence !== undefined && <b>{Math.round(confidence * 100)}%</b>}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </button>
      <div className="media-card-actions">
        <button
          type="button"
          className={item.isFavorite ? "favorite active" : "favorite"}
          aria-label={item.isFavorite ? "お気に入りから外す" : "お気に入りに追加"}
          aria-pressed={item.isFavorite}
          disabled={working}
          onClick={() => onFavorite(item)}
        >
          <Icon name="star" />
        </button>
        <button type="button" aria-label="Windowsのごみ箱へ移動" disabled={working} onClick={() => onRecycle(item)}>
          <Icon name="trash" />
        </button>
      </div>
    </article>
  );
});

export function MediaCollection({
  eyebrow, title, description, kinds, favoritesOnly, showFavoriteKindFilter, emptyTitle, emptyDescription,
  advancedGallerySearch = false, viewerIncludesAllMedia = false,
  initialSearch = "", initialRootId, initialFolderPath, embedded = false,
  compactFileLayout = false, onBack,
  onNavigateFolderPath, leadingFolders = [], onOpenLeadingFolder, favoriteFolderKeys,
  onToggleLeadingFolderFavorite, onAddFolder, onDataChanged,
  tagNavigation, refreshVersion,
}: MediaCollectionProps) {
  const [pages, setPages] = useState<Map<number, MediaItem[]>>(() => new Map());
  const [pageInfo, setPageInfo] = useState<MediaPageInfo>({ totalCount: 0, dateGroups: [] });
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [rootId, setRootId] = useState(initialRootId ?? "");
  const [favoriteKind, setFavoriteKind] = useState<FavoriteKindFilter>("");
  const [displayPreferences, setDisplayPreferences] = useState(defaultGalleryDisplayPreferences);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nativeAvailable, setNativeAvailable] = useState(true);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<MediaItem>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<Map<string, MediaItem>>(() => new Map());
  const [selectionAnchor, setSelectionAnchor] = useState<{ mediaId: string; index: number }>();
  const [rangeSelectionProgress, setRangeSelectionProgress] = useState<RangeSelectionProgress>();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkEditorSection, setBulkEditorSection] = useState<"tags" | "details">();
  const [workingId, setWorkingId] = useState<string>();
  const [gallerySearchOpen, setGallerySearchOpen] = useState(false);
  const [searchHistory, setSearchHistory] = useState<GallerySearchHistoryEntry[]>([]);
  const [contextMenu, setContextMenu] = useState<GalleryContextMenuState>();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [pageLoadRevision, setPageLoadRevision] = useState(0);
  const [viewport, setViewport] = useState({ width: 900, height: 620, scrollTop: 0 });
  const [galleryFilters, setGalleryFilters] = useState<GallerySearchFilters>(() => ({
    ...EMPTY_GALLERY_SEARCH_FILTERS,
    mediaFormats: [],
    tagIds: [],
    query: initialSearch,
    rootId: initialRootId,
    folderPath: initialRootId ? initialFolderPath : undefined,
  }));
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef(pages);
  const inFlightPages = useRef(new Set<string>());
  const failedPageLoads = useRef(new Set<string>());
  const pageLoadFailureCounts = useRef(new Map<string, number>());
  const pageRetryTimers = useRef(new Map<string, number>());
  const currentQueryKey = useRef("");
  const catalogLoadGeneration = useRef(0);
  const visiblePage = useRef(0);
  const scrollFrame = useRef<number | undefined>(undefined);
  const scrollIdleTimer = useRef<number | undefined>(undefined);
  const pendingScrollTop = useRef(0);
  const actualScrollTop = useRef(0);
  const quietReload = useRef(false);
  const quietReloadQueryKey = useRef<string | undefined>(undefined);
  const selectedMediaRef = useRef(selectedMedia);
  const viewerReturnTarget = useRef<{ mediaId: string; index: number } | undefined>(undefined);
  const lastExternalRefreshVersion = useRef(refreshVersion);
  const rangeSelectionGeneration = useRef(0);
  const rangeSelectionOperation = useRef<ReturnType<typeof startOperation> | undefined>(undefined);
  const cancelRangeSelection = useCallback((announce = false) => {
    rangeSelectionGeneration.current += 1;
    const operation = rangeSelectionOperation.current;
    rangeSelectionOperation.current = undefined;
    if (operation) {
      if (announce) operation.cancel("範囲選択を中止しました");
      else operation.dismiss();
    }
    setRangeSelectionProgress(undefined);
  }, []);
  const translateTag = useTagTranslations();
  const gridSize = compactFileLayout ? "minimum" : displayPreferences.gridSize;
  const { sortBy, sortDirection } = sortQuery(displayPreferences.sortOrder);
  const groupMode: GalleryGroupMode = displayPreferences.groupMode;

  useEffect(() => {
    selectedMediaRef.current = selectedMedia;
  }, [selectedMedia]);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  useEffect(() => {
    setGalleryViewerActive(Boolean(selected));
    return () => setGalleryViewerActive(false);
  }, [Boolean(selected)]);
  useEffect(() => setSearch(initialSearch), [initialSearch]);
  useEffect(() => setRootId(initialRootId ?? ""), [initialRootId]);
  useEffect(() => {
    if (!initialRootId) return;
    setGalleryFilters((current) => ({
      ...current,
      query: initialSearch,
      rootId: initialRootId,
      folderPath: initialFolderPath,
    }));
    setSearch(initialSearch);
    setDebouncedSearch(initialSearch.trim());
  }, [initialFolderPath, initialRootId, initialSearch]);
  useEffect(() => {
    if (!advancedGallerySearch || !tagNavigation) return;
    const nextRootId = tagNavigation.scope === "folder"
      ? tagNavigation.rootId ?? ""
      : "";
    const nextFolderPath = tagNavigation.scope === "folder"
      ? tagNavigation.folderPath
      : undefined;
    setRootId(nextRootId);
    setSearch("");
    setDebouncedSearch("");
    setGalleryFilters((current) => ({
      ...current,
      query: "",
      rootId: nextRootId || undefined,
      folderPath: nextFolderPath,
      tagIds: [tagNavigation.tagId],
    }));
    setGallerySearchOpen(false);
    setSelected(undefined);
  }, [advancedGallerySearch, tagNavigation]);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true;
    void loadGalleryDisplayPreferences().then((loaded) => {
      if (active) setDisplayPreferences(loaded);
    });
    const handlePreferences = (event: Event) => {
      const next = normalizeGalleryDisplayPreferences(
        (event as CustomEvent<GalleryDisplayPreferences>).detail,
      );
      setDisplayPreferences(next);
    };
    window.addEventListener(galleryDisplayPreferencesEvent, handlePreferences);
    return () => {
      active = false;
      window.removeEventListener(galleryDisplayPreferencesEvent, handlePreferences);
    };
  }, []);

  useEffect(() => {
    if (!advancedGallerySearch) return;
    let active = true;
    void loadGallerySearchHistory().then((history) => {
      if (!active) return;
      setSearchHistory(history);
    });
    const handlePreferences = () => {
      void loadGallerySearchHistory().then((history) => {
        if (active) setSearchHistory(history);
      });
    };
    window.addEventListener(searchAndGroupingPreferencesEvent, handlePreferences);
    return () => {
      active = false;
      window.removeEventListener(searchAndGroupingPreferencesEvent, handlePreferences);
    };
  }, [advancedGallerySearch]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", handleKey);
    };
  }, [contextMenu]);

  const galleryKinds = useMemo(
    () => advancedGallerySearch ? gallerySearchMediaKinds(galleryFilters.mediaFormats) : undefined,
    [advancedGallerySearch, galleryFilters.mediaFormats],
  );
  const allowedGalleryFormats = useMemo<GallerySearchMediaFormat[]>(() => {
    if (!advancedGallerySearch || !kinds) return ["image", "gif", "video", "book"];
    const allowed: GallerySearchMediaFormat[] = [];
    if (kinds.includes("image")) allowed.push("image");
    if (kinds.includes("gif")) allowed.push("gif");
    if (kinds.includes("video")) allowed.push("video");
    if (kinds.includes("pdf") || kinds.includes("archive")) allowed.push("book");
    return allowed;
  }, [advancedGallerySearch, kinds]);
  const activeKinds = useMemo<MediaKind[] | undefined>(
    () => advancedGallerySearch
      ? galleryKinds?.filter((kind) => kinds?.includes(kind)).length
        ? galleryKinds.filter((kind) => kinds?.includes(kind))
        : kinds
      : (
      showFavoriteKindFilter && favoriteKind
        ? favoriteKind === "book"
          ? ["pdf", "archive"]
          : [favoriteKind]
        : kinds
    ),
    [advancedGallerySearch, favoriteKind, galleryKinds, kinds, showFavoriteKindFilter],
  );

  useEffect(() => {
    if (!advancedGallerySearch) return;
    setGalleryFilters((current) => {
      const mediaFormats = current.mediaFormats.filter((format) => allowedGalleryFormats.includes(format));
      return mediaFormats.length === current.mediaFormats.length
        ? current
        : { ...current, mediaFormats };
    });
  }, [advancedGallerySearch, allowedGalleryFormats]);
  const baseQuery = useMemo<MediaQuery>(() => ({
    kind: activeKinds,
    favoritesOnly,
    search: debouncedSearch || undefined,
    rootId: (initialRootId ?? rootId) || undefined,
    folderPath: initialFolderPath !== undefined
      ? galleryFilters.folderPath ?? initialFolderPath
      : advancedGallerySearch
        ? galleryFilters.folderPath
        : undefined,
    ageRating: advancedGallerySearch
      ? (galleryFilters.ageRating ?? displayPreferences.ageRating) || undefined
      : displayPreferences.ageRating || undefined,
    tagIds: advancedGallerySearch ? galleryFilters.tagIds : undefined,
    ...(advancedGallerySearch ? gallerySearchModifiedRange(galleryFilters) : {}),
    sortBy,
    sortDirection,
    includeDateGroups: groupMode !== "none",
  }), [
    activeKinds, advancedGallerySearch, debouncedSearch, favoritesOnly,
    galleryFilters.ageRating, galleryFilters.customFrom, galleryFilters.customTo,
    galleryFilters.folderPath, galleryFilters.period, galleryFilters.tagIds,
    displayPreferences.ageRating, groupMode, initialFolderPath, initialRootId, rootId, sortBy, sortDirection,
  ]);
  const queryKey = useMemo(() => JSON.stringify(baseQuery), [baseQuery]);

  useEffect(() => {
    cancelRangeSelection();
    setSelectedMedia(new Map());
    setSelectionMode(false);
    setSelectionAnchor(undefined);
    setBulkEditorSection(undefined);
  }, [cancelRangeSelection, queryKey]);

  useEffect(() => {
    const host = scrollerRef.current;
    if (!host) return;
    const update = () => setViewport((current) => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      return current.width === width && current.height === height
        ? current
        : { ...current, width, height };
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [loading, pageInfo.totalCount]);

  useEffect(() => () => {
    if (scrollFrame.current !== undefined) {
      window.cancelAnimationFrame(scrollFrame.current);
    }
    if (scrollIdleTimer.current !== undefined) {
      window.clearTimeout(scrollIdleTimer.current);
    }
    scrollerRef.current?.classList.remove("is-scrolling");
    setGalleryScrollActive(false);
    catalogLoadGeneration.current += 1;
    rangeSelectionGeneration.current += 1;
    rangeSelectionOperation.current?.dismiss();
    rangeSelectionOperation.current = undefined;
    pageRetryTimers.current.forEach((timer) => window.clearTimeout(timer));
    pageRetryTimers.current.clear();
  }, []);

  const loadInfo = useCallback(async (quiet = false) => {
    const loadGeneration = catalogLoadGeneration.current + 1;
    catalogLoadGeneration.current = loadGeneration;
    const pagesToRevalidate = quiet ? [...pagesRef.current.keys()] : [];
    if (quiet) setRefreshing(true);
    else {
      setLoading(true);
      setRefreshing(false);
    }
    setError(undefined);
    // A refresh creates a new catalog generation. Requests from the old
    // generation may still finish, but must never occupy the visible-page
    // concurrency slots or suppress retries for the new generation.
    inFlightPages.current.clear();
    failedPageLoads.current.clear();
    pageLoadFailureCounts.current.clear();
    pageRetryTimers.current.forEach((timer) => window.clearTimeout(timer));
    pageRetryTimers.current.clear();
    if (!quiet) {
      setPages(new Map());
    }
    if (!quiet) {
      visiblePage.current = 0;
      if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
      pendingScrollTop.current = 0;
      actualScrollTop.current = 0;
      setViewport((current) => ({ ...current, scrollTop: 0 }));
    }
    currentQueryKey.current = queryKey;

    // Paint the first small page before asking SQLite to aggregate the full
    // count/date groups. On a huge catalog this makes the first usable cards
    // appear immediately while the complete scroll geometry catches up.
    const firstPageResult = await listMediaItems({
      ...baseQuery,
      limit: MEDIA_PAGE_SIZE,
      offset: 0,
    }, { fresh: quiet });
    if (
      currentQueryKey.current !== queryKey
      || catalogLoadGeneration.current !== loadGeneration
    ) return;
    const hasProvisionalPage = !firstPageResult.error && firstPageResult.data.length > 0;
    if (hasProvisionalPage) {
      const provisionalDates = new Map<string, number>();
      for (const item of firstPageResult.data) {
        const date = item.modifiedAt?.slice(0, 10);
        if (date) provisionalDates.set(date, (provisionalDates.get(date) ?? 0) + 1);
      }
      setPages((current) => quiet
        ? new Map(current).set(0, firstPageResult.data)
        : new Map([[0, firstPageResult.data]]));
      if (!quiet) {
        setPageInfo({
          totalCount: firstPageResult.data.length,
          dateGroups: [...provisionalDates].map(([date, itemCount]) => ({ date, itemCount })),
        });
      }
      setNativeAvailable(firstPageResult.available);
      if (!quiet) setLoading(false);
    }

    // Root summaries are useful for the selector, but neither they nor the
    // full catalog aggregation should block the provisional first page.
    const infoRequest = getMediaPageInfo(baseQuery, { fresh: quiet });
    const rootRequest = listLibraryRoots();
    const infoResult = await infoRequest;
    if (
      currentQueryKey.current !== queryKey
      || catalogLoadGeneration.current !== loadGeneration
    ) return;
    if (!infoResult.error) {
      setPageInfo(infoResult.data);
      if (
        !quiet
        && hasProvisionalPage
        && firstPageResult.data.length < Math.min(MEDIA_PAGE_SIZE, infoResult.data.totalCount)
      ) {
        // The catalog grew between the provisional page and the aggregate
        // query. Drop the incomplete page so the normal page loader refetches
        // page zero against the newer geometry instead of leaving blank slots.
        setPages((current) => {
          const next = new Map(current);
          next.delete(0);
          return next;
        });
      }
    } else if (!hasProvisionalPage) {
      setPageInfo(infoResult.data);
    }
    setNativeAvailable(infoResult.available);
    // A failed provisional request is retried by the normal page loader once
    // the canonical count is known, so do not leave that transient error
    // visible after the aggregate query itself succeeded.
    setError(infoResult.error);
    setLoading(false);
    if (quiet && !infoResult.error) {
      const maximumPage = Math.ceil(infoResult.data.totalCount / MEDIA_PAGE_SIZE) - 1;
      const orderedPages = pagesToRevalidate
        .filter((page) => page !== 0 && page <= maximumPage)
        .sort((left, right) => Math.abs(left - visiblePage.current) - Math.abs(right - visiblePage.current));
      setPages((current) => {
        const next = new Map(current);
        for (const page of next.keys()) {
          if (page > maximumPage) next.delete(page);
        }
        return next;
      });
      let cursor = 0;
      const refreshWorker = async () => {
        while (cursor < orderedPages.length) {
          const page = orderedPages[cursor];
          cursor += 1;
          const result = await listMediaItems({
            ...baseQuery,
            limit: MEDIA_PAGE_SIZE,
            offset: page * MEDIA_PAGE_SIZE,
          }, { fresh: true });
          if (
            result.error
            || currentQueryKey.current !== queryKey
            || catalogLoadGeneration.current !== loadGeneration
          ) continue;
          setPages((current) => new Map(current).set(page, result.data));
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(MEDIA_PAGE_LOAD_CONCURRENCY, orderedPages.length) },
        () => refreshWorker(),
      ));
    }
    setRefreshing(false);
    void rootRequest.then((rootResult) => {
      if (
        currentQueryKey.current !== queryKey
        || catalogLoadGeneration.current !== loadGeneration
      ) return;
      setRoots(rootResult.data);
      setNativeAvailable((current) => current && rootResult.available);
      if (rootResult.error) setError((current) => current ?? rootResult.error);
    });
  }, [baseQuery, queryKey]);

  useEffect(() => {
    const quiet = quietReload.current && quietReloadQueryKey.current === queryKey;
    quietReload.current = false;
    quietReloadQueryKey.current = undefined;
    const timer = window.setTimeout(() => void loadInfo(quiet), 60);
    return () => window.clearTimeout(timer);
  }, [loadInfo, queryKey, reloadVersion]);

  const visibleLeadingFolders = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("ja");
    if (!needle) return leadingFolders;
    return leadingFolders.filter((folder) =>
      `${folder.name} ${folder.displayPath}`.toLocaleLowerCase("ja").includes(needle),
    );
  }, [leadingFolders, search]);
  const metrics = useMemo(
    () => gridMetrics(gridSize, viewport.width, compactFileLayout),
    [compactFileLayout, gridSize, viewport.width],
  );
  const leadingFolderRows = Math.ceil(visibleLeadingFolders.length / metrics.columns);
  const leadingFolderHeight = visibleLeadingFolders.length > 0
    ? leadingFolderRows * metrics.rowHeight
    : 0;
  const virtualLayout = useMemo(
    () => {
      const mediaLayout = buildVirtualGroups(pageInfo, metrics, groupMode);
      return {
        groups: mediaLayout.groups.map((group) => ({
          ...group,
          top: group.top + leadingFolderHeight,
        })),
        totalHeight: mediaLayout.totalHeight + leadingFolderHeight,
      };
    },
    [groupMode, leadingFolderHeight, metrics, pageInfo],
  );

  const visibleLayout = useMemo(() => {
    const top = Math.max(0, viewport.scrollTop - metrics.rowHeight * VIRTUAL_OVERSCAN_ROWS);
    const bottom = viewport.scrollTop + viewport.height + metrics.rowHeight * VIRTUAL_OVERSCAN_ROWS;
    const slots: VirtualSlot[] = [];
    const visibleGroups: VirtualDateGroup[] = [];
    let firstIndex = Number.POSITIVE_INFINITY;
    let lastIndex = -1;
    const availableWidth = Math.max(1, viewport.width);
    const cardWidth = (availableWidth - VIRTUAL_GAP * (metrics.columns - 1)) / metrics.columns;
    const folderSlots = visibleLeadingFolders.flatMap((folder, index) => {
      const row = Math.floor(index / metrics.columns);
      const slotTop = row * metrics.rowHeight;
      if (slotTop + metrics.rowHeight < top || slotTop > bottom) return [];
      const column = index % metrics.columns;
      return [{
        folder,
        top: slotTop,
        left: column * (cardWidth + VIRTUAL_GAP),
        width: cardWidth,
        height: metrics.rowHeight - VIRTUAL_GAP,
      }];
    });
    const firstGroup = firstVisibleGroupIndex(virtualLayout.groups, top);
    for (let groupIndex = firstGroup; groupIndex < virtualLayout.groups.length; groupIndex += 1) {
      const group = virtualLayout.groups[groupIndex];
      if (group.top > bottom) break;
      visibleGroups.push(group);
      const rowsTop = group.top + group.headerHeight;
      const firstRow = Math.max(0, Math.floor((top - rowsTop) / metrics.rowHeight));
      const lastRow = Math.min(
        group.rows - 1,
        Math.max(0, Math.floor((bottom - rowsTop) / metrics.rowHeight)),
      );
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = 0; column < metrics.columns; column += 1) {
          const index = group.startIndex + row * metrics.columns + column;
          if (index >= group.startIndex + group.itemCount) break;
          firstIndex = Math.min(firstIndex, index);
          lastIndex = Math.max(lastIndex, index);
          slots.push({
            index,
            top: rowsTop + row * metrics.rowHeight,
            left: column * (cardWidth + VIRTUAL_GAP),
            width: cardWidth,
            height: metrics.rowHeight - VIRTUAL_GAP,
          });
        }
      }
    }
    return {
      slots,
      folderSlots,
      groups: visibleGroups,
      firstIndex: Number.isFinite(firstIndex) ? firstIndex : 0,
      lastIndex,
    };
  }, [metrics, viewport, virtualLayout, visibleLeadingFolders]);

  useEffect(() => {
    if (pageInfo.totalCount === 0 || visibleLayout.lastIndex < visibleLayout.firstIndex) return;
    const firstPage = Math.floor(visibleLayout.firstIndex / MEDIA_PAGE_SIZE);
    const lastPage = Math.floor(visibleLayout.lastIndex / MEDIA_PAGE_SIZE);
    visiblePage.current = Math.floor((firstPage + lastPage) / 2);
    const loadGeneration = catalogLoadGeneration.current;
    const candidates: number[] = [];
    for (let page = firstPage; page <= lastPage; page += 1) {
      const requestKey = `${queryKey}:${loadGeneration}:${page}`;
      if (
        pages.has(page)
        || inFlightPages.current.has(requestKey)
        || failedPageLoads.current.has(requestKey)
      ) continue;
      candidates.push(page);
    }
    candidates.sort((left, right) =>
      Math.abs(left - visiblePage.current) - Math.abs(right - visiblePage.current)
      || left - right,
    );
    const availableSlots = Math.max(
      0,
      MEDIA_PAGE_LOAD_CONCURRENCY - inFlightPages.current.size,
    );
    for (const page of candidates.slice(0, availableSlots)) {
      const requestKey = `${queryKey}:${loadGeneration}:${page}`;
      inFlightPages.current.add(requestKey);
      const previousFailures = pageLoadFailureCounts.current.get(requestKey) ?? 0;
      const expectedLength = Math.max(0, Math.min(
        MEDIA_PAGE_SIZE,
        pageInfo.totalCount - page * MEDIA_PAGE_SIZE,
      ));
      const scheduleRetry = (message: string, incompleteResult = false) => {
        const failures = (pageLoadFailureCounts.current.get(requestKey) ?? 0) + 1;
        pageLoadFailureCounts.current.set(requestKey, failures);
        failedPageLoads.current.add(requestKey);
        setError(message);

        // A repeatedly short page means the count and page snapshot changed
        // between queries. Refresh their shared geometry instead of leaving
        // permanent skeleton slots at the end or middle of a large folder.
        if (incompleteResult && failures >= MEDIA_PAGE_SHORT_RESULT_RELOAD_ATTEMPTS) {
          failedPageLoads.current.delete(requestKey);
          pageLoadFailureCounts.current.delete(requestKey);
          invalidateMediaQueryCache(false);
          quietReload.current = true;
          quietReloadQueryKey.current = queryKey;
          setReloadVersion((current) => current + 1);
          return;
        }

        const delay = Math.min(
          MEDIA_PAGE_RETRY_MAX_MS,
          MEDIA_PAGE_RETRY_BASE_MS * (2 ** Math.min(failures - 1, 4)),
        );
        const timer = window.setTimeout(() => {
          pageRetryTimers.current.delete(requestKey);
          failedPageLoads.current.delete(requestKey);
          if (
            currentQueryKey.current === queryKey
            && catalogLoadGeneration.current === loadGeneration
          ) {
            setPageLoadRevision((current) => current + 1);
          }
        }, delay);
        pageRetryTimers.current.set(requestKey, timer);
      };
      void listMediaItems({
        ...baseQuery,
        limit: MEDIA_PAGE_SIZE,
        offset: page * MEDIA_PAGE_SIZE,
      }, { fresh: previousFailures > 0 }).then((result) => {
        inFlightPages.current.delete(requestKey);
        if (
          currentQueryKey.current !== queryKey
          || catalogLoadGeneration.current !== loadGeneration
        ) return;
        if (result.error) {
          scheduleRetry(result.error);
          return;
        }
        if (result.data.length < expectedLength) {
          scheduleRetry(
            `メディアページを再同期しています（${result.data.length} / ${expectedLength} 件）`,
            true,
          );
          return;
        }
        failedPageLoads.current.delete(requestKey);
        pageLoadFailureCounts.current.delete(requestKey);
        setNativeAvailable(result.available);
        setPages((current) => {
          return addBoundedMediaPage(current, page, result.data, visiblePage.current);
        });
      }).catch((cause) => {
        inFlightPages.current.delete(requestKey);
        if (
          currentQueryKey.current !== queryKey
          || catalogLoadGeneration.current !== loadGeneration
        ) return;
        scheduleRetry(cause instanceof Error ? cause.message : "メディアページを読み込めませんでした。");
      });
    }
  }, [baseQuery, pageInfo.totalCount, pageLoadRevision, pages, queryKey, visibleLayout]);

  const { itemByIndex, mediaIndexById, loadedItems } = useMemo(() => {
    const indexed = new Map<number, MediaItem>();
    const indexesById = new Map<string, number>();
    const loaded: MediaItem[] = [];
    const sortedPages = [...pages.keys()].sort((left, right) => left - right);
    for (const page of sortedPages) {
      const items = pages.get(page);
      if (!items) continue;
      items.forEach((item, index) => {
        const itemIndex = page * MEDIA_PAGE_SIZE + index;
        indexed.set(itemIndex, item);
        indexesById.set(item.id, itemIndex);
      });
      loaded.push(...items);
    }
    return { itemByIndex: indexed, mediaIndexById: indexesById, loadedItems: loaded };
  }, [pages]);
  const thumbnailPrefetchTargets = useMemo<ThumbnailPrefetchTarget[]>(() => {
    const viewportTop = viewport.scrollTop;
    const viewportBottom = viewportTop + viewport.height;
    return visibleLayout.slots.flatMap((slot) => {
      const item = itemByIndex.get(slot.index);
      if (!item) return [];
      const intersectsViewport = slot.top + slot.height >= viewportTop
        && slot.top <= viewportBottom;
      return [{
        mediaId: item.id,
        revision: item.modifiedAt,
        knownPath: item.thumbnailPath,
        priority: intersectsViewport ? "visible" : "nearby",
      } satisfies ThumbnailPrefetchTarget];
    });
  }, [itemByIndex, viewport.height, viewport.scrollTop, visibleLayout.slots]);

  useEffect(
    () => prefetchThumbnails(thumbnailPrefetchTargets),
    [thumbnailPrefetchTargets],
  );
  const selectedMediaItems = useMemo(() => [...selectedMedia.values()], [selectedMedia]);
  const rangeSelecting = rangeSelectionProgress !== undefined;
  const allLoadedSelected = loadedItems.length > 0
    && loadedItems.every((item) => selectedMedia.has(item.id));

  const patchCachedItem = useCallback((mediaId: string, patch: Partial<MediaItem>) => {
    setPages((current) => {
      for (const [page, items] of current) {
        const index = items.findIndex((item) => item.id === mediaId);
        if (index < 0) continue;
        const nextItems = items.slice();
        nextItems[index] = { ...items[index], ...patch };
        const next = new Map(current);
        next.set(page, nextItems);
        return next;
      }
      return current;
    });
    setSelected((current) => current?.id === mediaId ? { ...current, ...patch } : current);
    setSelectedMedia((current) => {
      const item = current.get(mediaId);
      if (!item) return current;
      const next = new Map(current);
      next.set(mediaId, { ...item, ...patch });
      return next;
    });
  }, []);

  const requestCatalogReload = useCallback(() => {
    cancelRangeSelection();
    invalidateMediaCatalogCache({ preserveThumbnails: true });
    setSelectedMedia(new Map());
    setSelectionMode(false);
    setSelectionAnchor(undefined);
    setBulkEditorSection(undefined);
    quietReload.current = true;
    quietReloadQueryKey.current = queryKey;
    setReloadVersion((current) => current + 1);
  }, [cancelRangeSelection, queryKey]);

  useEffect(() => {
    if (
      refreshVersion === undefined
      || lastExternalRefreshVersion.current === refreshVersion
    ) return;
    lastExternalRefreshVersion.current = refreshVersion;
    requestCatalogReload();
  }, [refreshVersion, requestCatalogReload]);

  useEffect(() => {
    const handleAiCompleted = () => {
      requestCatalogReload();
      onDataChanged?.();
    };
    window.addEventListener("pixvault:ai-analysis-completed", handleAiCompleted);
    return () => window.removeEventListener("pixvault:ai-analysis-completed", handleAiCompleted);
  }, [onDataChanged, requestCatalogReload]);

  useEffect(() => {
    const handleMissingMedia = (event: Event) => {
      const mediaId = (event as CustomEvent<{ mediaId?: string }>).detail?.mediaId;
      if (!mediaId) return;
      setSelected((current) => current?.id === mediaId ? undefined : current);
      requestCatalogReload();
      onDataChanged?.();
    };
    window.addEventListener("pixvault:media-missing", handleMissingMedia);
    return () => window.removeEventListener("pixvault:media-missing", handleMissingMedia);
  }, [onDataChanged, requestCatalogReload]);

  const removeFavoriteFromFilteredView = useCallback((item: MediaItem) => {
    catalogLoadGeneration.current += 1;
    inFlightPages.current.clear();
    failedPageLoads.current.clear();
    setPages((current) => {
      for (const [page, items] of current) {
        if (!items.some((candidate) => candidate.id === item.id)) continue;
        // The following favorites shift forward after removal. Drop only the
        // affected page and later retained pages; the visible-page scheduler
        // refills only what is needed without a full count/date-group query.
        return new Map(
          [...current].filter(([pageNumber]) => pageNumber < page),
        );
      }
      return current;
    });
    setPageInfo((current) => {
      const date = item.modifiedAt?.slice(0, 10);
      return {
        totalCount: Math.max(0, current.totalCount - 1),
        dateGroups: date
          ? current.dateGroups.flatMap((group) => {
              if (group.date !== date) return [group];
              const itemCount = group.itemCount - 1;
              return itemCount > 0 ? [{ ...group, itemCount }] : [];
            })
          : current.dateGroups,
      };
    });
    setSelectedMedia((current) => {
      if (!current.has(item.id)) return current;
      const next = new Map(current);
      next.delete(item.id);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback(async (item: MediaItem) => {
    setWorkingId(item.id);
    const next = !item.isFavorite;
    const result = await setFavorite(item.id, next);
    setWorkingId(undefined);
    if (result.error || !result.available) {
      setError(result.error ?? "ブラウザプレビューではお気に入りを変更できません。");
      return;
    }
    if (favoritesOnly && !next) removeFavoriteFromFilteredView(item);
    else patchCachedItem(item.id, { isFavorite: next });
    onDataChanged?.();
  }, [favoritesOnly, onDataChanged, patchCachedItem, removeFavoriteFromFilteredView]);

  const recycle = useCallback(async (item: MediaItem) => {
    if (!window.confirm(`「${item.name}」をWindowsのごみ箱へ移動しますか？\nアプリ内から完全削除は行いません。`)) return;
    setWorkingId(item.id);
    const result = await recycleMediaItem(item.id);
    setWorkingId(undefined);
    if (result.error || !result.data) {
      setError(result.error ?? (result.available ? "Windowsのごみ箱へ移動できませんでした。" : "ブラウザプレビューではファイルを操作できません。"));
      return;
    }
    setSelected(undefined);
    requestCatalogReload();
    onDataChanged?.();
  }, [onDataChanged, requestCatalogReload]);

  const toggleMediaSelection = useCallback((
    item: MediaItem,
    itemIndex: number,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (event.shiftKey) {
      if (!selectionAnchor) {
        cancelRangeSelection();
        setSelectedMedia((current) => {
          const next = new Map(current);
          next.set(item.id, item);
          return next;
        });
        setSelectionAnchor({ mediaId: item.id, index: itemIndex });
        return;
      }

      cancelRangeSelection();
      const rangeStart = Math.min(selectionAnchor.index, itemIndex);
      const rangeEnd = Math.max(selectionAnchor.index, itemIndex);
      const rangeTotal = rangeEnd - rangeStart + 1;
      const rangeItemIds = new Set<string>();
      const immediatelyAvailable: MediaItem[] = [];
      for (const [index, loadedItem] of itemByIndex) {
        if (index < rangeStart || index > rangeEnd) continue;
        immediatelyAvailable.push(loadedItem);
        rangeItemIds.add(loadedItem.id);
      }
      const anchorItem = selectedMediaRef.current.get(selectionAnchor.mediaId);
      if (anchorItem && !rangeItemIds.has(anchorItem.id)) {
        immediatelyAvailable.push(anchorItem);
        rangeItemIds.add(anchorItem.id);
      }
      if (!rangeItemIds.has(item.id)) {
        immediatelyAvailable.push(item);
        rangeItemIds.add(item.id);
      }

      setSelectedMedia((current) => {
        const next = new Map(current);
        immediatelyAvailable.forEach((availableItem) => {
          next.set(availableItem.id, availableItem);
        });
        return next;
      });

      const missingBatches: Array<{ offset: number; limit: number }> = [];
      for (
        let offset = rangeStart;
        offset <= rangeEnd;
        offset += RANGE_SELECTION_BATCH_SIZE
      ) {
        const limit = Math.min(RANGE_SELECTION_BATCH_SIZE, rangeEnd - offset + 1);
        let complete = true;
        for (let index = offset; index < offset + limit; index += 1) {
          if (!itemByIndex.has(index)) {
            complete = false;
            break;
          }
        }
        if (!complete) missingBatches.push({ offset, limit });
      }
      if (missingBatches.length === 0) return;

      setError(undefined);
      const requestGeneration = rangeSelectionGeneration.current;
      const operation = startOperation({
        label: "範囲を選択中",
        detail: `${Math.min(rangeItemIds.size, rangeTotal).toLocaleString("ja-JP")} / ${rangeTotal.toLocaleString("ja-JP")} 件`,
        progress: Math.min(100, (rangeItemIds.size / rangeTotal) * 100),
      });
      rangeSelectionOperation.current = operation;
      setRangeSelectionProgress({
        selected: Math.min(rangeItemIds.size, rangeTotal),
        total: rangeTotal,
      });

      void (async () => {
        try {
          for (const batch of missingBatches) {
            if (rangeSelectionGeneration.current !== requestGeneration) return;
            const result = await listMediaItems({
              ...baseQuery,
              limit: batch.limit,
              offset: batch.offset,
            });
            if (rangeSelectionGeneration.current !== requestGeneration) return;
            if (result.error || result.data.length !== batch.limit) {
              throw new Error(
                result.error
                ?? `範囲内のメディアを取得できませんでした（${result.data.length} / ${batch.limit} 件）`,
              );
            }

            result.data.forEach((rangeItem) => rangeItemIds.add(rangeItem.id));
            setSelectedMedia((current) => {
              const next = new Map(current);
              result.data.forEach((rangeItem) => {
                next.set(rangeItem.id, rangeItem);
              });
              return next;
            });
            const selectedCount = Math.min(rangeItemIds.size, rangeTotal);
            setRangeSelectionProgress({ selected: selectedCount, total: rangeTotal });
            operation.update({
              detail: `${selectedCount.toLocaleString("ja-JP")} / ${rangeTotal.toLocaleString("ja-JP")} 件`,
              progress: Math.min(100, (selectedCount / rangeTotal) * 100),
            });

            // Give React a paint opportunity between cached/native batches so
            // the count grows progressively even across a very large range.
            await new Promise<void>((resolve) => {
              window.requestAnimationFrame(() => resolve());
            });
          }

          if (rangeSelectionGeneration.current !== requestGeneration) return;
          if (rangeItemIds.size < rangeTotal) {
            throw new Error(
              `範囲選択が未完了です（${rangeItemIds.size} / ${rangeTotal} 件）`,
            );
          }
          rangeSelectionOperation.current = undefined;
          setRangeSelectionProgress(undefined);
          operation.succeed(`${rangeTotal.toLocaleString("ja-JP")} 件を選択しました`);
        } catch (cause) {
          if (rangeSelectionGeneration.current !== requestGeneration) return;
          rangeSelectionOperation.current = undefined;
          setRangeSelectionProgress(undefined);
          operation.fail(cause);
          setError(cause instanceof Error ? cause.message : "範囲選択に失敗しました。");
        }
      })();
      return;
    }

    cancelRangeSelection();
    const willSelect = !selectedMediaRef.current.has(item.id);
    setSelectedMedia((current) => {
      const next = new Map(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
    if (willSelect) {
      setSelectionAnchor({ mediaId: item.id, index: itemIndex });
    } else if (selectionAnchor?.mediaId === item.id) {
      setSelectionAnchor(undefined);
    }
  }, [baseQuery, cancelRangeSelection, itemByIndex, selectionAnchor]);

  const activateItem = useCallback((
    item: MediaItem,
    itemIndex: number,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    if (selectionMode || event.ctrlKey || event.metaKey || event.shiftKey) {
      if (!selectionMode) setSelectionMode(true);
      toggleMediaSelection(item, itemIndex, event);
      return;
    }
    viewerReturnTarget.current = { mediaId: item.id, index: itemIndex };
    setSelected(item);
  }, [selectionMode, toggleMediaSelection]);

  const handleViewerCurrentIdChange = useCallback((
    mediaId: string,
    pagedItem?: MediaItem,
    pagedIndex?: number,
  ) => {
    const nextItem = pagedItem ?? loadedItems.find((candidate) => candidate.id === mediaId);
    const nextIndex = pagedIndex ?? mediaIndexById.get(mediaId);
    if (!nextItem || nextIndex === undefined) return;
    viewerReturnTarget.current = { mediaId, index: nextIndex };
    setSelected(nextItem);
  }, [loadedItems, mediaIndexById]);

  const closeViewerAndRestore = useCallback(() => {
    const target = viewerReturnTarget.current;
    setSelected(undefined);
    if (!target) return;
    const host = scrollerRef.current;
    if (!host) return;
    const group = virtualLayout.groups.find((candidate) =>
      target.index >= candidate.startIndex
      && target.index < candidate.startIndex + candidate.itemCount);
    const itemTop = group
      ? group.top
        + group.headerHeight
        + Math.floor((target.index - group.startIndex) / metrics.columns) * metrics.rowHeight
      : 0;
    const nextScrollTop = Math.max(
      0,
      Math.min(
        virtualLayout.totalHeight - host.clientHeight,
        itemTop - (host.clientHeight - metrics.rowHeight) / 2,
      ),
    );
    host.scrollTop = nextScrollTop;
    actualScrollTop.current = nextScrollTop;
    pendingScrollTop.current = nextScrollTop;
    const quantizedScrollTop = quantizeScrollTop(
      nextScrollTop,
      metrics.rowHeight,
      virtualLayout.groups,
      leadingFolderHeight,
    );
    setViewport((current) => (
      current.scrollTop === quantizedScrollTop
        ? current
        : { ...current, scrollTop: quantizedScrollTop }
    ));
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const slot = [...host.querySelectorAll<HTMLElement>("[data-media-id]")]
          .find((candidate) => candidate.dataset.mediaId === target.mediaId);
        slot?.querySelector<HTMLButtonElement>(".media-open")?.focus({ preventScroll: true });
      });
    });
  }, [leadingFolderHeight, metrics.columns, metrics.rowHeight, virtualLayout.groups, virtualLayout.totalHeight]);

  const stopSelection = useCallback(() => {
    cancelRangeSelection();
    setSelectedMedia(new Map());
    setSelectionMode(false);
    setSelectionAnchor(undefined);
    setBulkEditorSection(undefined);
  }, [cancelRangeSelection]);

  const toggleAllLoaded = useCallback(() => {
    cancelRangeSelection();
    setSelectedMedia((current) => {
      const next = new Map(current);
      if (allLoadedSelected) {
        loadedItems.forEach((item) => next.delete(item.id));
      } else {
        loadedItems.forEach((item) => next.set(item.id, item));
      }
      return next;
    });
  }, [allLoadedSelected, cancelRangeSelection, loadedItems]);

  const bulkFavorite = useCallback(async () => {
    const targets = selectedMediaItems;
    if (targets.length === 0 || bulkBusy) return;
    const makeFavorite = targets.some((item) => !item.isFavorite);
    const operation = startOperation({
      label: makeFavorite ? "お気に入りへ一括追加" : "お気に入りを一括解除",
      detail: `${targets.length.toLocaleString("ja-JP")}件を処理します`,
      progress: 0,
    });
    setBulkBusy(true);
    setError(undefined);
    let completed = 0;
    const failures: string[] = [];
    const successfulUpdates: Array<{ mediaId: string; isFavorite: boolean }> = [];
    await runWithConcurrency(targets, 4, async (item) => {
      try {
        const result = await setFavorite(item.id, makeFavorite, { deferCacheInvalidation: true });
        if (result.error || !result.data) {
          failures.push(`${item.name}: ${result.error ?? "変更できませんでした"}`);
          return;
        }
        successfulUpdates.push({ mediaId: item.id, isFavorite: makeFavorite });
        if (favoritesOnly && !makeFavorite) {
          removeFavoriteFromFilteredView(item);
        } else {
          patchCachedItem(item.id, { isFavorite: makeFavorite });
        }
      } catch (cause) {
        failures.push(`${item.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        completed += 1;
        operation.update({
          detail: `${completed.toLocaleString("ja-JP")} / ${targets.length.toLocaleString("ja-JP")}件`,
          progress: completed / targets.length * 100,
        });
      }
    });
    patchFavoriteQueryCacheBatch(successfulUpdates);
    setBulkBusy(false);
    if (failures.length > 0) {
      const message = `${targets.length - failures.length}件完了、${failures.length}件失敗しました。${failures[0]}`;
      setError(message);
      operation.fail(message);
    } else {
      operation.succeed(`${targets.length.toLocaleString("ja-JP")}件を変更しました`);
    }
    onDataChanged?.();
  }, [
    bulkBusy,
    favoritesOnly,
    onDataChanged,
    patchCachedItem,
    removeFavoriteFromFilteredView,
    selectedMediaItems,
  ]);

  const bulkRecycle = useCallback(async () => {
    const targets = selectedMediaItems;
    if (targets.length === 0 || bulkBusy) return;
    if (!window.confirm(
      `選択した${targets.length.toLocaleString("ja-JP")}件をWindowsのごみ箱へ移動しますか？\nアプリ内から完全削除は行いません。`,
    )) return;
    const operation = startOperation({
      label: "選択メディアをごみ箱へ移動",
      detail: `${targets.length.toLocaleString("ja-JP")}件を処理します`,
      progress: 0,
    });
    setBulkBusy(true);
    setError(undefined);
    let completed = 0;
    let removed = 0;
    const failures: string[] = [];
    await runWithConcurrency(targets, 1, async (item) => {
      try {
        const result = await recycleMediaItem(item.id, { deferCacheInvalidation: true });
        if (result.error || !result.data) {
          failures.push(`${item.name}: ${result.error ?? "ごみ箱へ移動できませんでした"}`);
          return;
        }
        removed += 1;
      } catch (cause) {
        failures.push(`${item.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        completed += 1;
        operation.update({
          detail: `${completed.toLocaleString("ja-JP")} / ${targets.length.toLocaleString("ja-JP")}件`,
          progress: completed / targets.length * 100,
        });
      }
    });
    setBulkBusy(false);
    if (failures.length > 0) {
      const message = `${removed}件を移動、${failures.length}件失敗しました。${failures[0]}`;
      setError(message);
      operation.fail(message);
    } else {
      operation.succeed(`${removed.toLocaleString("ja-JP")}件をごみ箱へ移動しました`);
    }
    if (removed > 0) {
      stopSelection();
      setSelected(undefined);
      requestCatalogReload();
      onDataChanged?.();
    }
  }, [
    bulkBusy,
    onDataChanged,
    requestCatalogReload,
    selectedMediaItems,
    stopSelection,
  ]);

  const applyBulkEdit = useCallback(async (request: BulkMediaEditRequest) => {
    const targets = selectedMediaItems;
    if (targets.length === 0 || bulkBusy) return;
    const operation = startOperation({
      label: "選択メディアを一括編集",
      detail: `${targets.length.toLocaleString("ja-JP")}件を処理します`,
      progress: 0,
    });
    setBulkBusy(true);
    setError(undefined);
    let completed = 0;
    const failures: string[] = [];
    await runWithConcurrency(targets, 3, async (item) => {
      const itemErrors: string[] = [];
      if (request.ageRating) {
        try {
          const ratingResult = await setAgeRating(
            item.id,
            request.ageRating,
            { deferCacheInvalidation: true },
          );
          if (ratingResult.error || !ratingResult.available) {
            itemErrors.push(ratingResult.error ?? "年齢区分を変更できませんでした");
          } else {
            patchCachedItem(item.id, { ageRating: ratingResult.data });
          }
        } catch (cause) {
          itemErrors.push(cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (request.applyTags) {
        const nextTags = request.tagMode === "replace"
          ? request.tags
          : [...new Map(
              [...item.tags, ...request.tags].map((tag) => [tag.id, tag]),
            ).values()];
        try {
          const tagResult = await setMediaTags(
            item.id,
            nextTags.map((tag) => tag.id),
            { deferCacheInvalidation: true },
          );
          if (tagResult.error || !tagResult.data) {
            itemErrors.push(tagResult.error ?? "タグを変更できませんでした");
          } else {
            patchCachedItem(item.id, { tags: nextTags });
          }
        } catch (cause) {
          itemErrors.push(cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (itemErrors.length > 0) failures.push(`${item.name}: ${itemErrors.join(" / ")}`);
      completed += 1;
      operation.update({
        detail: `${completed.toLocaleString("ja-JP")} / ${targets.length.toLocaleString("ja-JP")}件 · ${item.name}`,
        progress: completed / targets.length * 100,
      });
    });
    setBulkBusy(false);
    invalidateMediaQueryCache(false);
    setBulkEditorSection(undefined);
    if (failures.length > 0) {
      const message = `${targets.length - failures.length}件完了、${failures.length}件で一部または全部が失敗しました。${failures[0]}`;
      setError(message);
      operation.fail(message);
    } else {
      operation.succeed(`${targets.length.toLocaleString("ja-JP")}件へ反映しました`);
    }
    const leavesActiveAgeFilter = Boolean(
      request.ageRating
      && baseQuery.ageRating
      && request.ageRating !== baseQuery.ageRating,
    );
    const canLeaveActiveTagFilter = Boolean(
      request.applyTags
      && request.tagMode === "replace"
      && (baseQuery.tagIds?.length ?? 0) > 0,
    );
    if (leavesActiveAgeFilter || canLeaveActiveTagFilter) {
      requestCatalogReload();
    }
    onDataChanged?.();
  }, [
    baseQuery.ageRating,
    baseQuery.tagIds,
    bulkBusy,
    onDataChanged,
    patchCachedItem,
    requestCatalogReload,
    selectedMediaItems,
  ]);

  const openGalleryContextMenu = useCallback((
    event: ReactMouseEvent<HTMLElement>,
    item?: MediaItem,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 286;
    const height = item ? 650 : 540;
    setContextMenu({
      x: Math.max(10, Math.min(event.clientX, window.innerWidth - width - 10)),
      y: Math.max(10, Math.min(event.clientY, window.innerHeight - height - 10)),
      item,
    });
  }, []);

  const updateDisplayPreferences = useCallback(async (
    patch: Partial<GalleryDisplayPreferences>,
  ) => {
    const previous = displayPreferences;
    const next = mergeGalleryDisplayPreferences(previous, patch);
    setDisplayPreferences(next);
    setContextMenu(undefined);
    const result = await saveGalleryDisplayPreferences(next);
    if (!result.saved) {
      setDisplayPreferences(previous);
      setError(result.error);
    }
  }, [displayPreferences]);

  const updateItemAgeRating = useCallback(async (item: MediaItem, rating: AgeRating) => {
    setContextMenu(undefined);
    setWorkingId(item.id);
    const result = await setAgeRating(item.id, rating);
    setWorkingId(undefined);
    if (result.error || !result.available) {
      setError(result.error ?? "ブラウザプレビューでは年齢区分を変更できません。");
      return;
    }
    patchCachedItem(item.id, { ageRating: result.data });
    if (baseQuery.ageRating && baseQuery.ageRating !== result.data) {
      requestCatalogReload();
    }
    onDataChanged?.();
  }, [baseQuery.ageRating, onDataChanged, patchCachedItem, requestCatalogReload]);

  const copyContextImage = useCallback(async (item: MediaItem) => {
    setContextMenu(undefined);
    const operation = startOperation({
      label: "画像をコピー",
      detail: item.name,
      progress: null,
    });
    try {
      if (!("ClipboardItem" in window) || !navigator.clipboard?.write) {
        throw new Error("この環境では画像のクリップボードコピーを利用できません。");
      }
      const blob = await browserCompatibleImageBlob(item);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      operation.succeed("画像をクリップボードへコピーしました");
    } catch (copyError) {
      const message = copyError instanceof Error ? copyError.message : "画像をコピーできませんでした。";
      setError(message);
      operation.fail(message);
    }
  }, []);

  const shareContextImage = useCallback(async (item: MediaItem) => {
    setContextMenu(undefined);
    const operation = startOperation({
      label: "画像を共有",
      detail: item.name,
      progress: null,
    });
    try {
      const blob = await browserCompatibleImageBlob(item);
      const baseName = item.name.replace(/\.[^.]+$/, "") || "PixVault_Image";
      const file = new File([blob], `${baseName}.png`, { type: "image/png" });
      const shareData: ShareData = { title: item.name, files: [file] };
      if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
        await navigator.share(shareData);
        operation.succeed("共有先へ画像を渡しました");
        return;
      }
      if (!("ClipboardItem" in window) || !navigator.clipboard?.write) {
        throw new Error("この環境では共有機能を利用できません。");
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      operation.succeed("共有機能がないためクリップボードへコピーしました");
    } catch (shareError) {
      const message = shareError instanceof Error ? shareError.message : "画像を共有できませんでした。";
      setError(message);
      operation.fail(message);
    }
  }, []);

  function applyGallerySearch(filters: GallerySearchFilters) {
    const next = initialRootId
      ? { ...filters, rootId: initialRootId }
      : filters;
    setGalleryFilters(next);
    setSearch(filters.query);
    setDebouncedSearch(filters.query.trim());
    if (!initialRootId) setRootId(filters.rootId ?? "");
    void rememberGallerySearch(next).then(setSearchHistory);
  }

  function restoreGallerySearch(entry: GallerySearchHistoryEntry) {
    applyGallerySearch(entry.filters);
  }

  function clearGallerySearch() {
    const empty = {
      ...EMPTY_GALLERY_SEARCH_FILTERS,
      mediaFormats: [],
      tagIds: [],
      query: "",
      rootId: initialRootId,
      folderPath: initialRootId ? initialFolderPath : undefined,
    };
    setGalleryFilters(empty);
    setSearch("");
    setDebouncedSearch("");
    if (!initialRootId) setRootId("");
  }

  function navigateGalleryFolder(path: string | undefined) {
    if (initialRootId) {
      onNavigateFolderPath?.(path);
      return;
    }
    if (!advancedGallerySearch) return;
    setGalleryFilters((current) => ({
      ...current,
      rootId: path === undefined ? undefined : current.rootId,
      folderPath: path,
    }));
    if (path === undefined) setRootId("");
  }

  const folderLabel = initialFolderPath
    ? initialFolderPath.split("/").filter(Boolean).pop()
    : undefined;
  const breadcrumbRootId = initialRootId
    ?? (advancedGallerySearch ? galleryFilters.rootId : undefined);
  const breadcrumbPath = initialFolderPath !== undefined
    ? initialFolderPath
    : advancedGallerySearch
      ? galleryFilters.folderPath
      : undefined;
  const breadcrumbRoot = roots.find((root) => root.id === breadcrumbRootId);
  const breadcrumbSegments = breadcrumbPath?.split("/").filter(Boolean) ?? [];
  const openAiForCurrentScope = () => {
    openAiAnalysisPanel({
      rootId: initialRootId ?? galleryFilters.rootId,
      folderPath: initialRootId !== undefined
        ? initialFolderPath
        : galleryFilters.folderPath,
      currentFolderOnly: initialRootId !== undefined,
    });
  };
  const galleryFilterActive = advancedGallerySearch && (
    galleryFilters.query.trim().length > 0
    || galleryFilters.mediaFormats.length > 0
    || Boolean(galleryFilters.ageRating)
    || galleryFilters.tagIds.length > 0
    || galleryFilters.period !== "all"
    || (!initialRootId && hasGallerySearchFilters(galleryFilters))
    || (Boolean(initialRootId) && galleryFilters.folderPath !== initialFolderPath)
  );
  return (
    <div
      className={embedded ? "media-page embedded-media-collection" : "page media-page"}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button, input, textarea, select, [role='dialog']")) return;
        openGalleryContextMenu(event);
      }}
    >
      {!embedded && <PageHeader
        eyebrow={eyebrow}
        title={folderLabel ? `${title} / ${folderLabel}` : title}
        titleContent={breadcrumbRootId ? (
          <span className="page-title-hierarchy" role="navigation" aria-label="表示中のフォルダー階層">
            <button type="button" onClick={() => navigateGalleryFolder(undefined)}>{title}</button>
            <Icon name="chevronRight" />
            <button
              type="button"
              onClick={() => {
                if (initialRootId) navigateGalleryFolder("");
                else setGalleryFilters((current) => ({ ...current, folderPath: undefined }));
              }}
            >
              {breadcrumbRoot?.displayName ?? "登録フォルダー"}
            </button>
            {breadcrumbSegments.map((segment, index) => {
              const path = breadcrumbSegments.slice(0, index + 1).join("/");
              const current = index === breadcrumbSegments.length - 1;
              return (
                <span key={path}>
                  <Icon name="chevronRight" />
                  <button
                    type="button"
                    className={current ? "current" : undefined}
                    aria-current={current ? "page" : undefined}
                    onClick={() => navigateGalleryFolder(path)}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </span>
        ) : undefined}
        description={folderLabel ? `「${initialFolderPath}」直下のアイテムです。` : description}
        onTitleClick={onBack ?? (advancedGallerySearch
          ? () => navigateGalleryFolder(undefined)
          : undefined)}
        actions={(
          <div className="page-actions">
            {onBack && (
              <button className="secondary-button back-button" type="button" onClick={onBack}>
                <Icon name="arrowRight" />フォルダーへ戻る
              </button>
            )}
            {breadcrumbRoot && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void openFolderInExplorer(breadcrumbRoot, breadcrumbPath, setError)}
              >
                <Icon name="folder" />エクスプローラー
              </button>
            )}
            {advancedGallerySearch && (
              <button
                className="ai-analysis-open-button"
                type="button"
                onClick={openAiForCurrentScope}
              >
                <Icon name="sparkles" />AI分析
              </button>
            )}
            <button
              className="secondary-button"
              type="button"
              onClick={requestCatalogReload}
              disabled={refreshing}
            >
              <Icon name="refresh" className={refreshing ? "rotating" : undefined} />更新
            </button>
          </div>
        )}
      />}
      {!embedded && !nativeAvailable && <NativePreviewNotice />}
      {refreshing && (
        <div className="collection-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" /><span>カタログ情報を更新しています…</span>
        </div>
      )}
      {error && (
        <StatusPanel
          tone="error"
          icon="warning"
          title="ライブラリーを読み込めませんでした"
          action={<button type="button" className="text-button" onClick={requestCatalogReload}>再試行</button>}
        >
          <p>{error}</p>
        </StatusPanel>
      )}
      {showFavoriteKindFilter && (
        <div className="media-kind-filter" aria-label="お気に入りの形式">
          <span>形式</span>
          <div>
            {favoriteKindOptions.map((option) => (
              <button
                type="button"
                key={option.label}
                className={favoriteKind === option.value ? "active" : ""}
                aria-pressed={favoriteKind === option.value}
                onClick={() => setFavoriteKind(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="collection-toolbar" role="search">
        <label className="search-field">
          <Icon name="search" />
          <span className="sr-only">メディアを検索</span>
          <input
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              if (advancedGallerySearch) {
                setGalleryFilters((current) => ({ ...current, query: value }));
              }
            }}
            type="search"
            placeholder="名前・タグを検索"
          />
        </label>
        {advancedGallerySearch && (
          <button
            className={galleryFilterActive ? "advanced-search-button active" : "advanced-search-button"}
            type="button"
            onClick={() => setGallerySearchOpen(true)}
          >
            <Icon name="filter" />詳細検索{galleryFilterActive && <span>設定中</span>}
          </button>
        )}
        {advancedGallerySearch && galleryFilterActive && (
          <button
            className="search-filter-clear-button"
            type="button"
            onClick={clearGallerySearch}
          >
            <Icon name="close" />検索条件をクリア
          </button>
        )}
        {embedded && advancedGallerySearch && (
          <button
            className="ai-analysis-open-button"
            type="button"
            onClick={openAiForCurrentScope}
          >
            <Icon name="sparkles" />AI分析
          </button>
        )}
        <button
          className={selectionMode ? "gallery-selection-toggle active" : "gallery-selection-toggle"}
          type="button"
          aria-pressed={selectionMode}
          disabled={bulkBusy}
          onClick={() => {
            if (selectionMode) stopSelection();
            else setSelectionMode(true);
          }}
        >
          <Icon name="check" />{selectionMode ? "選択終了" : "複数選択"}
        </button>
        {!initialRootId && (
          <StyledSelect
            label="フォルダー"
            value={rootId}
            onChange={(value) => {
              setRootId(value);
              if (advancedGallerySearch) {
                setGalleryFilters((current) => ({ ...current, rootId: value || undefined, folderPath: undefined }));
              }
            }}
            options={[{ value: "", label: "すべて" }, ...roots.map((root) => ({ value: root.id, label: root.displayName }))]}
          />
        )}
        <StyledSelect
          label="グループ化"
          value={groupMode}
          onChange={(value) => void updateDisplayPreferences({ groupMode: value as GalleryGroupMode })}
          options={galleryGroupOptions}
        />
      </div>
      {selectionMode && (
        <div className="gallery-bulk-toolbar" role="toolbar" aria-label="選択したメディアの一括操作">
          <div className="gallery-bulk-count" aria-live="polite">
            <span><Icon name="check" /></span>
            <div>
              <strong>{selectedMediaItems.length.toLocaleString("ja-JP")}件を選択</strong>
              {rangeSelectionProgress ? (
                <small
                  className="gallery-range-selection-status"
                  role="progressbar"
                  aria-label="範囲選択の進捗"
                  aria-valuemin={0}
                  aria-valuemax={rangeSelectionProgress.total}
                  aria-valuenow={rangeSelectionProgress.selected}
                >
                  <Icon name="refresh" className="rotating" />
                  範囲選択中 {rangeSelectionProgress.selected.toLocaleString("ja-JP")}
                  {" / "}
                  {rangeSelectionProgress.total.toLocaleString("ja-JP")}件
                </small>
              ) : (
                <small>Shift+クリックで範囲選択、Ctrl+クリックで個別選択できます</small>
              )}
            </div>
          </div>
          <div className="gallery-bulk-actions">
            {rangeSelectionProgress && (
              <button
                type="button"
                className="gallery-bulk-subtle"
                onClick={() => cancelRangeSelection(true)}
              >
                <Icon name="stop" />範囲選択を中止
              </button>
            )}
            <button
              type="button"
              className="gallery-bulk-subtle"
              disabled={bulkBusy || rangeSelecting || loadedItems.length === 0}
              onClick={toggleAllLoaded}
            >
              <Icon name={allLoadedSelected ? "close" : "check"} />
              {allLoadedSelected ? "読込済みを解除" : "読込済みをすべて選択"}
            </button>
            <button
              type="button"
              disabled={bulkBusy || rangeSelecting || selectedMediaItems.length === 0}
              onClick={() => void bulkFavorite()}
            >
              <Icon name="star" />
              {selectedMediaItems.length === 0 || selectedMediaItems.some((item) => !item.isFavorite)
                ? "お気に入り"
                : "お気に入り解除"}
            </button>
            <button
              type="button"
              disabled={bulkBusy || rangeSelecting || selectedMediaItems.length === 0}
              onClick={() => setBulkEditorSection("tags")}
            >
              <Icon name="tag" />タグ
            </button>
            <button
              type="button"
              disabled={bulkBusy || rangeSelecting || selectedMediaItems.length === 0}
              onClick={() => setBulkEditorSection("details")}
            >
              <Icon name="settings" />編集
            </button>
            <button
              type="button"
              className="gallery-bulk-danger"
              disabled={bulkBusy || rangeSelecting || selectedMediaItems.length === 0}
              onClick={() => void bulkRecycle()}
            >
              <Icon name="trash" />ごみ箱
            </button>
            <button
              type="button"
              className="gallery-bulk-close"
              aria-label="複数選択を終了"
              disabled={bulkBusy}
              onClick={stopSelection}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
      )}
      {advancedGallerySearch
        && tagNavigation
        && galleryFilters.tagIds.includes(tagNavigation.tagId) && (
          <div className="tag-gallery-filter-banner" aria-live="polite">
            <span className="tag-gallery-filter-icon"><Icon name="tag" /></span>
            <div>
              <small>TAG GALLERY</small>
              <strong>「{translateTag(tagNavigation.tagName)}」のメディア</strong>
              <span>
                {rootId
                  ? `${roots.find((root) => root.id === rootId)?.displayName ?? "現在の登録フォルダー"}${galleryFilters.folderPath ? ` / ${galleryFilters.folderPath}` : ""}`
                  : "すべての登録フォルダー"}
              </span>
            </div>
            {rootId && (
              <button
                type="button"
                onClick={() => {
                  setRootId("");
                  setGalleryFilters((current) => ({
                    ...current,
                    rootId: undefined,
                    folderPath: undefined,
                  }));
                }}
              >
                全フォルダーを表示
              </button>
            )}
            <button
              type="button"
              className="tag-gallery-filter-clear"
              aria-label="タグ絞り込みを解除"
              onClick={() => setGalleryFilters((current) => ({
                ...current,
                tagIds: current.tagIds.filter((tagId) => tagId !== tagNavigation.tagId),
              }))}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
      {loading ? (
        <LoadingPanel label="メディア件数を読み込み中…" />
      ) : pageInfo.totalCount === 0 && visibleLeadingFolders.length === 0 ? (
        <EmptyState
          icon={favoritesOnly ? "star" : kinds?.includes("video") ? "video" : kinds?.includes("pdf") ? "book" : "gallery"}
          title={search ? "検索結果がありません" : emptyTitle}
          description={search ? "検索語やフィルターを変更してください。" : emptyDescription}
          action={!search && onAddFolder
            ? <button className="primary-button" type="button" onClick={onAddFolder}><Icon name="folderPlus" />フォルダーを追加</button>
            : undefined}
        />
      ) : (
        <>
          <div className="result-meta" aria-live="polite">
            <span>
              {visibleLeadingFolders.length > 0 && `フォルダー ${visibleLeadingFolders.length.toLocaleString("ja-JP")} 件 · `}
              メディア {pageInfo.totalCount.toLocaleString("ja-JP")} 件
            </span>
            <span>表示範囲だけを読み込み中 · {loadedItems.length.toLocaleString("ja-JP")} 件キャッシュ</span>
          </div>
          <div
            className={`virtual-media-scroller grid-size-${gridSize}${compactFileLayout ? " compact-file-layout" : ""}`}
            ref={scrollerRef}
            style={{ "--gallery-visual-size": `${metrics.visualHeight}px` } as CSSProperties}
            onContextMenu={(event) => openGalleryContextMenu(event)}
            onScroll={(event) => {
              const host = event.currentTarget;
              const scrollTop = host.scrollTop;
              actualScrollTop.current = scrollTop;
              pendingScrollTop.current = scrollTop;
              host.classList.add("is-scrolling");
              setGalleryScrollActive(true);

              if (scrollIdleTimer.current !== undefined) {
                window.clearTimeout(scrollIdleTimer.current);
              }
              scrollIdleTimer.current = window.setTimeout(() => {
                scrollIdleTimer.current = undefined;
                if (scrollerRef.current === host) host.classList.remove("is-scrolling");
                setGalleryScrollActive(false);
                const settledTop = quantizeScrollTop(
                  actualScrollTop.current,
                  metrics.rowHeight,
                  virtualLayout.groups,
                  leadingFolderHeight,
                );
                setViewport((current) => (
                  current.scrollTop === settledTop
                    ? current
                    : { ...current, scrollTop: settledTop }
                ));
              }, SCROLL_IDLE_MS);

              if (scrollFrame.current !== undefined) return;
              scrollFrame.current = window.requestAnimationFrame(() => {
                scrollFrame.current = undefined;
                const quantizedTop = quantizeScrollTop(
                  pendingScrollTop.current,
                  metrics.rowHeight,
                  virtualLayout.groups,
                  leadingFolderHeight,
                );
                setViewport((current) =>
                  current.scrollTop === quantizedTop
                    ? current
                    : { ...current, scrollTop: quantizedTop },
                );
              });
            }}
          >
            <div
              className="virtual-media-canvas"
              role="list"
              aria-label="ギャラリー項目"
              style={{ height: virtualLayout.totalHeight }}
            >
              {visibleLayout.folderSlots.map((slot) => (
                <div
                  className="virtual-media-slot virtual-folder-slot"
                  key={slot.folder.key}
                  style={{
                    top: slot.top,
                    left: slot.left,
                    width: slot.width,
                    height: slot.height,
                  }}
                >
                  <button
                    className="folder-card mixed-folder-card"
                    type="button"
                    onClick={() => onOpenLeadingFolder?.(slot.folder)}
                  >
                    <div className="folder-visual explorer-folder-visual">
                      <span className="explorer-folder-glyph"><Icon name="folderWindows" className="windows-folder-icon" /></span>
                      <span className="folder-item-count">{slot.folder.itemCount.toLocaleString("ja-JP")}</span>
                    </div>
                    <div>
                      <strong>{slot.folder.name}</strong>
                      <span title={slot.folder.displayPath}>{slot.folder.displayPath}</span>
                      <small>
                        {slot.folder.itemCount.toLocaleString("ja-JP")} 件
                        {slot.folder.hasChildren ? " · サブフォルダーあり" : ""}
                      </small>
                    </div>
                  </button>
                  {onToggleLeadingFolderFavorite && (
                    <button
                      className={`mixed-folder-favorite${favoriteFolderKeys?.has(folderActivityKey(slot.folder.rootId, slot.folder.relativeFolder)) ? " active" : ""}`}
                      type="button"
                      aria-label={favoriteFolderKeys?.has(folderActivityKey(slot.folder.rootId, slot.folder.relativeFolder)) ? "お気に入りフォルダーから外す" : "お気に入りフォルダーに追加"}
                      aria-pressed={favoriteFolderKeys?.has(folderActivityKey(slot.folder.rootId, slot.folder.relativeFolder))}
                      title={favoriteFolderKeys?.has(folderActivityKey(slot.folder.rootId, slot.folder.relativeFolder)) ? "お気に入りフォルダーから外す" : "お気に入りフォルダーに追加"}
                      onClick={() => onToggleLeadingFolderFavorite(slot.folder)}
                    >
                      <Icon name="star" />
                    </button>
                  )}
                </div>
              ))}
              {visibleLayout.groups.filter((group) => group.headerHeight > 0).map((group) => (
                <div
                  className="virtual-date-header"
                  key={group.date}
                  style={{ top: group.top, height: group.headerHeight }}
                >
                  <strong>{formatGroupDate(group.date, groupMode)}</strong>
                  <span>{group.itemCount.toLocaleString("ja-JP")} 件</span>
                </div>
              ))}
              {visibleLayout.slots.map((slot) => {
                const item = itemByIndex.get(slot.index);
                const thumbnailPriority: ThumbnailPriority = (
                  slot.top + slot.height >= viewport.scrollTop
                  && slot.top <= viewport.scrollTop + viewport.height
                ) ? "visible" : "nearby";
                return (
                  <div
                    className="virtual-media-slot"
                    key={slot.index}
                    data-media-id={item?.id}
                    style={{
                      top: slot.top,
                      left: slot.left,
                      width: slot.width,
                      height: slot.height,
                    }}
                  >
                    {item ? (
                      <MediaCard
                        item={item}
                        itemIndex={slot.index}
                        gridSize={gridSize}
                        compactFileLayout={compactFileLayout}
                        thumbnailPriority={thumbnailPriority}
                        working={bulkBusy || workingId === item.id}
                        selected={selectedMedia.has(item.id)}
                        selectionAnchor={selectionAnchor?.mediaId === item.id}
                        selectionMode={selectionMode}
                        translateTag={translateTag}
                        onActivate={activateItem}
                        onToggleSelection={toggleMediaSelection}
                        onFavorite={toggleFavorite}
                        onRecycle={recycle}
                        onContextMenu={openGalleryContextMenu}
                      />
                    ) : (
                      <div className="virtual-media-skeleton" aria-hidden="true">
                        <span />
                        <i />
                        <i />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      {contextMenu && (
        <div
          className="gallery-context-menu"
          role="menu"
          aria-label="ギャラリー表示設定"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenu.item && (contextMenu.item.kind === "image" || contextMenu.item.kind === "gif") && (
            <section>
              <span>画像の操作</span>
              <div className="gallery-context-options">
                <button type="button" role="menuitem" onClick={() => void copyContextImage(contextMenu.item!)}>
                  <Icon name="copy" />画像をコピー
                </button>
                <button type="button" role="menuitem" onClick={() => void shareContextImage(contextMenu.item!)}>
                  <Icon name="share" />共有
                </button>
              </div>
            </section>
          )}
          {contextMenu.item && (
            <section>
              <span>このメディアの年齢区分</span>
              <div className="gallery-context-options">
                {([
                  ["UNRATED", "未選択"],
                  ["SFW", "健全"],
                  ["R15", "R-15"],
                  ["R18", "R-18"],
                ] as const).map(([value, label]) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={contextMenu.item?.ageRating === value}
                    className={contextMenu.item?.ageRating === value ? "active" : ""}
                    key={value}
                    onClick={() => void updateItemAgeRating(contextMenu.item!, value)}
                  >
                    {label}{contextMenu.item?.ageRating === value && <Icon name="check" />}
                  </button>
                ))}
              </div>
            </section>
          )}
          {!compactFileLayout && <section>
            <span>サムネイルサイズ</span>
            <div className="gallery-context-options">
              {([
                ["minimum", "最小・10列"],
                ["small", "小・7列"],
                ["medium", "中・5列"],
                ["large", "大・3列"],
                ["maximum", "最大・2列"],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={gridSize === value}
                  className={gridSize === value ? "active" : ""}
                  key={value}
                  onClick={() => void updateDisplayPreferences({ gridSize: value })}
                >
                  {label}{gridSize === value && <Icon name="check" />}
                </button>
              ))}
            </div>
          </section>}
          <section>
            <span>グループ化</span>
            <div className="gallery-context-options">
              {galleryGroupOptions.map((option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={groupMode === option.value}
                  className={groupMode === option.value ? "active" : ""}
                  key={option.value}
                  onClick={() => void updateDisplayPreferences({ groupMode: option.value })}
                >
                  {option.label}{groupMode === option.value && <Icon name="check" />}
                </button>
              ))}
            </div>
          </section>
          <section>
            <span>並び順</span>
            <div className="gallery-context-options">
              {([
                ["modified-desc", "更新 新→旧"],
                ["modified-asc", "更新 旧→新"],
                ["name-asc", "名前 A→Z"],
                ["name-desc", "名前 Z→A"],
                ["size-desc", "サイズ 大→小"],
                ["size-asc", "サイズ 小→大"],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={displayPreferences.sortOrder === value}
                  className={displayPreferences.sortOrder === value ? "active" : ""}
                  key={value}
                  onClick={() => void updateDisplayPreferences({ sortOrder: value })}
                >
                  {label}{displayPreferences.sortOrder === value && <Icon name="check" />}
                </button>
              ))}
            </div>
          </section>
          <section>
            <span>表示する年齢制限</span>
            <div className="gallery-context-options">
              {([
                ["", "すべて"],
                ["UNRATED", "未選択"],
                ["SFW", "健全"],
                ["R15", "R-15"],
                ["R18", "R-18"],
              ] as const).map(([value, label]) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={displayPreferences.ageRating === value}
                  className={displayPreferences.ageRating === value ? "active" : ""}
                  key={value || "all"}
                  onClick={() => void updateDisplayPreferences({ ageRating: value })}
                >
                  {label}{displayPreferences.ageRating === value && <Icon name="check" />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
      {selected && (
        <Suspense fallback={null}>
          <MediaViewer
            items={loadedItems}
            currentId={selected.id}
            collection={viewerIncludesAllMedia ? {
              query: baseQuery,
              totalCount: pageInfo.totalCount,
              currentIndex: mediaIndexById.get(selected.id) ?? viewerReturnTarget.current?.index ?? 0,
              indexedItems: [...itemByIndex.entries()],
            } : undefined}
            onClose={closeViewerAndRestore}
            onItemPatch={(mediaId, patch) => {
              const currentItem = mediaId === selected.id
                ? selected
                : loadedItems.find((candidate) => candidate.id === mediaId);
              if (favoritesOnly && patch.isFavorite === false && currentItem) {
                removeFavoriteFromFilteredView(currentItem);
                setSelected((current) =>
                  current?.id === mediaId ? { ...current, ...patch } : current);
              } else {
                patchCachedItem(mediaId, patch);
              }
              onDataChanged?.();
            }}
            onRemove={(mediaId) => {
              setSelectedMedia((current) => {
                if (!current.has(mediaId)) return current;
                const next = new Map(current);
                next.delete(mediaId);
                return next;
              });
              requestCatalogReload();
              onDataChanged?.();
            }}
            onCurrentIdChange={handleViewerCurrentIdChange}
          />
        </Suspense>
      )}
      {advancedGallerySearch && (
        <GallerySearchModal
          open={gallerySearchOpen}
          value={galleryFilters}
          allowedMediaFormats={allowedGalleryFormats}
          fixedRootId={initialRootId}
          fixedFolderPath={initialFolderPath}
          history={searchHistory}
          onSelectHistory={restoreGallerySearch}
          onDeleteHistory={(id) => void removeGallerySearchHistory(id).then(setSearchHistory)}
          onApply={applyGallerySearch}
          onClear={clearGallerySearch}
          onClose={() => setGallerySearchOpen(false)}
        />
      )}
      <BulkMediaEditor
        open={bulkEditorSection !== undefined}
        count={selectedMediaItems.length}
        busy={bulkBusy}
        initialSection={bulkEditorSection ?? "details"}
        onClose={() => {
          if (!bulkBusy) setBulkEditorSection(undefined);
        }}
        onApply={(request) => void applyBulkEdit(request)}
      />
    </div>
  );
}

export function FolderMediaCollection({
  navigationKey, eyebrow, title, description, kinds, emptyTitle, emptyDescription,
  onAddFolder, onDataChanged, refreshVersion,
}: FolderMediaCollectionProps) {
  const savedNavigation = readFolderNavigation(navigationKey);
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [folderEntries, setFolderEntries] = useState<MediaFolder[]>([]);
  const [location, setLocation] = useState<{ rootId: string; path: string } | undefined>(
    savedNavigation?.location,
  );
  const [search, setSearch] = useState("");
  const [contentOpen, setContentOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mediaRefreshVersion, setMediaRefreshVersion] = useState(0);
  const [error, setError] = useState<string>();
  const folderActivity = useFolderActivity();
  const backStack = useRef<FolderNavigationState[]>([]);
  const forwardStack = useRef<FolderNavigationState[]>([]);
  const folderLoadGeneration = useRef(0);
  const lastRecordedLocation = useRef<string | undefined>(undefined);
  const lastExternalRefreshVersion = useRef(refreshVersion);

  useEffect(() => {
    rememberFolderNavigation(navigationKey, location);
  }, [location, navigationKey]);

  const restoreNavigation = useCallback((state: FolderNavigationState) => {
    setLocation(state.location);
    setSearch(state.search ?? "");
  }, []);

  const visitLocation = useCallback((nextLocation: FolderNavigationState["location"]) => {
    const unchanged = location?.rootId === nextLocation?.rootId
      && location?.path === nextLocation?.path;
    if (unchanged) {
      setSearch("");
      return;
    }
    backStack.current.push({ location, search });
    forwardStack.current = [];
    window.dispatchEvent(new Event("pixvault:history-branch"));
    setLocation(nextLocation);
    setSearch("");
  }, [location, search]);

  const goBack = useCallback(() => {
    const previous = backStack.current.pop();
    if (!previous) return false;
    forwardStack.current.push({ location, search });
    restoreNavigation(previous);
    return true;
  }, [location, restoreNavigation, search]);

  const goForward = useCallback(() => {
    const next = forwardStack.current.pop();
    if (!next) return false;
    backStack.current.push({ location, search });
    restoreNavigation(next);
    return true;
  }, [location, restoreNavigation, search]);

  useEffect(() => {
    const handleNavigateBack = (rawEvent: Event) => {
      if (backStack.current.length === 0) return;
      const event = rawEvent as CustomEvent<{ handled?: boolean }>;
      queueMicrotask(() => {
        if (event.defaultPrevented || event.detail?.handled) return;
        if (event.detail) event.detail.handled = true;
        event.preventDefault();
        goBack();
      });
    };
    const handleNavigateForward = (rawEvent: Event) => {
      if (forwardStack.current.length === 0) return;
      const event = rawEvent as CustomEvent<{ handled?: boolean }>;
      queueMicrotask(() => {
        if (event.defaultPrevented || event.detail?.handled) return;
        if (event.detail) event.detail.handled = true;
        event.preventDefault();
        goForward();
      });
    };
    window.addEventListener("pixvault:navigate-back", handleNavigateBack);
    window.addEventListener("pixvault:navigate-forward", handleNavigateForward);
    return () => {
      window.removeEventListener("pixvault:navigate-back", handleNavigateBack);
      window.removeEventListener("pixvault:navigate-forward", handleNavigateForward);
    };
  }, [goBack, goForward]);

  const loadRoots = useCallback(async (fresh = false) => {
    fresh ? setRefreshing(true) : setLoading(true);
    const result = await listLibraryRoots();
    setRoots(result.data);
    setError(result.error);
    setLoading(false);
    setRefreshing(false);
  }, []);
  useEffect(() => { void loadRoots(); }, [loadRoots]);

  useEffect(() => {
    if (!location) {
      folderLoadGeneration.current += 1;
      setFolderEntries([]);
      setRefreshing(false);
      return;
    }
    const loadGeneration = folderLoadGeneration.current + 1;
    folderLoadGeneration.current = loadGeneration;
    setLoading(true);
    setRefreshing(false);
    void listMediaFolders(location.rootId, kinds ?? []).then((result) => {
      if (folderLoadGeneration.current !== loadGeneration) return;
      setFolderEntries(result.data);
      setError(result.error);
      setLoading(false);
    });
    return () => {
      if (folderLoadGeneration.current === loadGeneration) {
        folderLoadGeneration.current += 1;
      }
    };
  }, [kinds, location?.rootId]);

  const selectedRoot = location
    ? roots.find((root) => root.id === location.rootId)
    : undefined;
  const childFolders = useMemo(() => {
    if (!location) return [];
    const needle = search.trim().toLocaleLowerCase("ja");
    return directChildFolders(
      folderEntries,
      location.rootId,
      location.path,
    ).filter((folder) =>
      !needle || `${folder.name} ${folder.displayPath}`.toLocaleLowerCase("ja").includes(needle),
    );
  }, [folderEntries, location, search, selectedRoot?.displayName]);
  const directCount = location ? currentFolderItemCount(folderEntries, location.path) : 0;
  const favoriteFolderKeys = useMemo(
    () => new Set(folderActivity.filter((record) => record.isFavorite).map((record) => record.key)),
    [folderActivity],
  );
  const favoriteFolders = useMemo(() => {
    const availableRoots = new Map(roots.map((root) => [root.id, root]));
    return folderActivity
      .filter((record) => record.isFavorite
        && (navigationKey === "all" || record.navigationKey === navigationKey)
        && availableRoots.has(record.rootId))
      .map((record) => ({ record, root: availableRoots.get(record.rootId)! }))
      .sort((left, right) => (right.record.lastVisitedAt ?? "")
        .localeCompare(left.record.lastVisitedAt ?? "")
        || left.record.displayName.localeCompare(right.record.displayName, "ja", { numeric: true }));
  }, [folderActivity, navigationKey, roots]);

  const activityInput = useCallback((
    root: LibraryRoot,
    path: string,
    displayName: string,
    itemCount: number,
  ): FolderActivityInput => ({
    rootId: root.id,
    relativePath: path,
    displayName,
    rootName: root.displayName,
    itemCount,
    navigationKey,
  }), [navigationKey]);

  const toggleFolderFavorite = useCallback((input: FolderActivityInput) => {
    const key = folderActivityKey(input.rootId, input.relativePath);
    const next = !favoriteFolderKeys.has(key);
    void setFolderFavorite(input, next).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "お気に入りフォルダーを保存できませんでした。");
    });
  }, [favoriteFolderKeys]);

  useEffect(() => {
    if (!location || !selectedRoot || loading) {
      if (!location) lastRecordedLocation.current = undefined;
      return;
    }
    const key = folderActivityKey(location.rootId, location.path);
    if (lastRecordedLocation.current === key) return;
    lastRecordedLocation.current = key;
    const locationSegments = location.path.split("/").filter(Boolean);
    const displayName = locationSegments[locationSegments.length - 1] ?? selectedRoot.displayName;
    void recordFolderVisit(activityInput(selectedRoot, location.path, displayName, directCount)).catch(() => {
      lastRecordedLocation.current = undefined;
    });
  }, [activityInput, directCount, loading, location, selectedRoot]);

  async function refreshFolders() {
    const loadGeneration = folderLoadGeneration.current + 1;
    folderLoadGeneration.current = loadGeneration;
    setRefreshing(true);
    const [rootResult, folderResult] = await Promise.all([
      listLibraryRoots(),
      location
        ? listMediaFolders(location.rootId, kinds ?? [], { fresh: true })
        : Promise.resolve(undefined),
    ]);
    if (folderLoadGeneration.current !== loadGeneration) return;
    setRoots(rootResult.data);
    if (folderResult) setFolderEntries(folderResult.data);
    setError(rootResult.error || folderResult?.error);
    setLoading(false);
    setRefreshing(false);
    setMediaRefreshVersion((current) => current + 1);
  }

  useEffect(() => {
    if (
      refreshVersion === undefined
      || lastExternalRefreshVersion.current === refreshVersion
    ) return;
    lastExternalRefreshVersion.current = refreshVersion;
    void refreshFolders();
  }, [refreshVersion]);

  const folderKindLabel = navigationKey === "all"
    ? "すべてのメディア"
    : kinds?.includes("video")
      ? "動画"
    : kinds?.includes("pdf") || kinds?.includes("archive")
      ? "ブック"
      : "画像・GIF";
  const compactFileGallery = navigationKey === "all" || navigationKey === "images" || navigationKey === "videos" || navigationKey === "books";
  const emptyIcon = navigationKey === "all"
    ? "gallery"
    : kinds?.includes("video")
      ? "video"
    : kinds?.includes("pdf") || kinds?.includes("archive")
      ? "book"
      : "image";
  const pathSegments = location?.path.split("/").filter(Boolean) ?? [];

  return (
    <div className={`page folder-browser-page${location ? " has-location" : ""}${compactFileGallery ? " compact-file-gallery" : ""}`}>
      <PageHeader
        eyebrow={eyebrow}
        title={location ? `${title} / ${pathSegments[pathSegments.length - 1] ?? selectedRoot?.displayName ?? ""}` : title}
        titleContent={location ? (
          <span className="page-title-hierarchy" role="navigation" aria-label="フォルダー階層">
            <button
              type="button"
              onClick={() => visitLocation(undefined)}
            >
              {title}
            </button>
            <Icon name="chevronRight" />
            <button
              type="button"
              className={pathSegments.length === 0 ? "current" : undefined}
              aria-current={pathSegments.length === 0 ? "page" : undefined}
              onClick={() => visitLocation({ ...location, path: "" })}
            >
              {selectedRoot?.displayName ?? "登録フォルダー"}
            </button>
            {pathSegments.map((segment, index) => {
              const path = pathSegments.slice(0, index + 1).join("/");
              const current = index === pathSegments.length - 1;
              return (
                <span key={path}>
                  <Icon name="chevronRight" />
                  <button
                    type="button"
                    className={current ? "current" : undefined}
                    aria-current={current ? "page" : undefined}
                    onClick={() => visitLocation({ ...location, path })}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </span>
        ) : undefined}
        description={location ? "現在のフォルダー直下にあるフォルダとメディアを、ひとつの一覧枠に表示します。" : description}
        actions={(
          <div className="page-actions">
            {location && (
              <button
                className={`secondary-button folder-favorite-button${favoriteFolderKeys.has(folderActivityKey(location.rootId, location.path)) ? " active" : ""}`}
                type="button"
                aria-pressed={favoriteFolderKeys.has(folderActivityKey(location.rootId, location.path))}
                onClick={() => selectedRoot && toggleFolderFavorite(activityInput(
                  selectedRoot,
                  location.path,
                  pathSegments[pathSegments.length - 1] ?? selectedRoot.displayName,
                  directCount,
                ))}
              >
                <Icon name="star" />{favoriteFolderKeys.has(folderActivityKey(location.rootId, location.path)) ? "お気に入り済み" : "フォルダーをお気に入り"}
              </button>
            )}
            {location && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void openFolderInExplorer(selectedRoot, location.path, setError)}
              >
                <Icon name="folderWindows" className="windows-folder-icon" />エクスプローラー
              </button>
            )}
            {location && (
              <button
                className="secondary-button back-button"
                type="button"
                onClick={() => window.dispatchEvent(new Event("pixvault:history-back"))}
              >
                <Icon name="arrowRight" />戻る
              </button>
            )}
            <button className="secondary-button" type="button" onClick={() => void refreshFolders()} disabled={refreshing}>
              <Icon name="refresh" className={refreshing ? "rotating" : undefined} />更新
            </button>
          </div>
        )}
      />
      {refreshing && (
        <div className="collection-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" /><span>フォルダー情報を更新しています…</span>
        </div>
      )}
      {error && <StatusPanel tone="error" icon="warning" title="フォルダーを読み込めませんでした"><p>{error}</p></StatusPanel>}
      {loading ? (
        <LoadingPanel label={location ? "直下のフォルダーを読み込み中…" : "登録フォルダーを読み込み中…"} />
      ) : !location ? (
        roots.length === 0 ? (
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle}
            description={emptyDescription}
            action={onAddFolder ? <button className="primary-button" type="button" onClick={onAddFolder}><Icon name="folderPlus" />フォルダーを追加</button> : undefined}
          />
        ) : (
          <>
          {(navigationKey === "images" || navigationKey === "all") && (
            <section className="favorite-folders-panel" aria-labelledby="favorite-folders-title">
              <header>
                <span className="favorite-folders-heading-icon"><Icon name="star" /></span>
                <span><p className="kicker">PINNED LOCATIONS</p><h2 id="favorite-folders-title">お気に入りフォルダー</h2><small>星を付けた{navigationKey === "all" ? "メディア" : "画像"}フォルダーへすぐに移動できます。</small></span>
              </header>
              {favoriteFolders.length === 0 ? (
                <div className="favorite-folders-empty"><Icon name="star" /><span><strong>お気に入りはまだありません</strong><small>フォルダーを開き、「フォルダーをお気に入り」を選ぶと追加できます。</small></span></div>
              ) : (
                <div className="favorite-folder-list">
                  {favoriteFolders.map(({ record, root }) => (
                    <article key={record.key}>
                      <button type="button" className="favorite-folder-open" onClick={() => visitLocation({ rootId: record.rootId, path: record.relativePath })}>
                        <span><Icon name="folderWindows" className="windows-folder-icon" /></span>
                        <span><strong>{record.displayName}</strong><small>{root.displayName}{record.relativePath ? ` / ${record.relativePath}` : " / ルート"}</small></span>
                        <em>{record.itemCount.toLocaleString("ja-JP")} 件</em>
                        <Icon name="chevronRight" />
                      </button>
                      <button type="button" className="favorite-folder-remove" aria-label={`${record.displayName}をお気に入りフォルダーから外す`} title="お気に入りから外す" onClick={() => toggleFolderFavorite(activityInput(root, record.relativePath, record.displayName, record.itemCount))}><Icon name="star" /></button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          <div className="folder-collection root-folder-collection">
            {roots.map((root) => (
              <article className="folder-card root-folder-card" key={root.id}>
                <button
                  className="root-folder-main"
                  type="button"
                  onClick={() => visitLocation({ rootId: root.id, path: "" })}
                >
                  <span className="folder-root-icon"><Icon name="folderWindows" className="windows-folder-icon" /></span>
                  <span className="root-folder-copy">
                    <strong>{root.displayName}</strong>
                    <span title={root.path}>{root.path}</span>
                    <small>登録フォルダーを開く</small>
                  </span>
                  <Icon name="chevronRight" />
                </button>
                <button
                  className={`root-folder-favorite${favoriteFolderKeys.has(folderActivityKey(root.id, "")) ? " active" : ""}`}
                  type="button"
                  title={favoriteFolderKeys.has(folderActivityKey(root.id, "")) ? "お気に入りフォルダーから外す" : "お気に入りフォルダーに追加"}
                  aria-label={favoriteFolderKeys.has(folderActivityKey(root.id, "")) ? `${root.displayName}をお気に入りフォルダーから外す` : `${root.displayName}をお気に入りフォルダーに追加`}
                  aria-pressed={favoriteFolderKeys.has(folderActivityKey(root.id, ""))}
                  onClick={() => toggleFolderFavorite(activityInput(root, "", root.displayName, root.mediaCount))}
                >
                  <Icon name="star" />
                </button>
                <button
                  className="root-folder-explorer"
                  type="button"
                  title={`${root.displayName}をエクスプローラーで開く`}
                  aria-label={`${root.displayName}をエクスプローラーで開く`}
                  onClick={() => void openFolderInExplorer(root, "", setError)}
                >
                  <Icon name="external" />
                </button>
              </article>
            ))}
          </div>
          </>
        )
      ) : (
        <div className="folder-split-content">
          <section className={`folder-content-frame unified-folder-media-frame ${contentOpen ? "is-open" : "is-collapsed"}`}>
            <header className="folder-frame-header">
              <div>
                <span className="folder-frame-icon"><Icon name="folderWindows" className="windows-folder-icon" /></span>
                <span>
                  <strong>フォルダとメディア</strong>
                  <small>フォルダ {childFolders.length.toLocaleString("ja-JP")} 件 · メディア {directCount.toLocaleString("ja-JP")} 件</small>
                </span>
              </div>
              <button
                type="button"
                aria-label={contentOpen ? "フォルダとメディアを閉じる" : "フォルダとメディアを開く"}
                aria-expanded={contentOpen}
                onClick={() => setContentOpen((current) => !current)}
              >
                <Icon name={contentOpen ? "minus" : "folderWindows"} className={!contentOpen ? "windows-folder-icon" : undefined} />
              </button>
            </header>
            <div className="folder-unified-body mixed-folder-media-body" hidden={!contentOpen}>
              <MediaCollection
                key={`${location.rootId}:${location.path}`}
                embedded
                advancedGallerySearch
                compactFileLayout={compactFileGallery}
                refreshVersion={mediaRefreshVersion}
                {...{ eyebrow, title, description, kinds }}
                emptyTitle="このフォルダーにアイテムはありません"
                emptyDescription={`${folderKindLabel}とサブフォルダーは見つかりませんでした。`}
                initialRootId={location.rootId}
                initialFolderPath={location.path}
                leadingFolders={childFolders}
                onOpenLeadingFolder={(folder) => visitLocation({
                  rootId: folder.rootId,
                  path: folder.relativeFolder,
                })}
                favoriteFolderKeys={favoriteFolderKeys}
                onToggleLeadingFolderFavorite={(folder) => {
                  if (!selectedRoot) return;
                  toggleFolderFavorite(activityInput(
                    selectedRoot,
                    folder.relativeFolder,
                    folder.name,
                    folder.itemCount,
                  ));
                }}
                onDataChanged={() => {
                  const loadGeneration = folderLoadGeneration.current + 1;
                  folderLoadGeneration.current = loadGeneration;
                  // Metadata-only edits (favorite, tags, age rating) do not
                  // change folder membership. Reuse the hierarchy cache; a
                  // recycle/rescan already invalidates it before this call.
                  void listMediaFolders(location.rootId, kinds ?? []).then((result) => {
                    if (folderLoadGeneration.current !== loadGeneration) return;
                    setFolderEntries(result.data);
                    setError(result.error);
                  });
                  onDataChanged?.();
                }}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
