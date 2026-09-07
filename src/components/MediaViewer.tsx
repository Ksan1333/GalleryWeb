import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useViewerFullscreen } from "../hooks/useViewerFullscreen";
import { bookSeekKeyPage, bookSeekPosition } from "../services/bookNavigation";
import { activateViewerDialog } from "../services/viewerDialog";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  getArchiveCover,
  getArchiveBookInfo,
  getArchiveBookPage,
  precacheArchiveBookPages,
  convertVideoToGif,
  getJsonPreference,
  getMediaImagePreview,
  getVisualRecommendations,
  listBookBookmarks,
  listMediaItems,
  listTags,
  localAssetUrl,
  mediaAssetUrl,
  recycleMediaItem,
  revealMediaInExplorer,
  saveCapture,
  searchAscii2d as requestAscii2dSearch,
  setJsonPreference,
  setAgeRating,
  setBookBookmark,
  setFavorite,
  setMediaTags,
  setWallpaper,
  upsertTag,
  type AgeRating,
  type MediaItem,
  type MediaKind,
  type MediaQuery,
  type Tag,
  type ViewerInfoLayout,
} from "../services/native";
import { useCoordinatedThumbnail } from "../services/thumbnailCoordinator";
import { useTagTranslations } from "../services/tagTranslations";
import { openTagGallery } from "../services/galleryNavigation";
import {
  BOOK_VIEWER_SETTINGS_EVENT,
  loadBookViewerSettings,
  saveBookViewerSettings,
  type BookBinding,
  type BookViewerSettingsValue,
  type BookViewMode,
} from "./BookViewerSettings";
import {
  DEFAULT_VIEWER_CONTROL_PREFERENCES,
  VIEWER_CONTROL_SETTINGS_EVENT,
  loadViewerControlPreferences,
  type ViewerActionId,
  type ViewerControlPreferences,
} from "./ViewerControlSettings";
import {
  DEFAULT_VIDEO_PLAYBACK_PREFERENCES,
  VIDEO_PLAYBACK_PREFERENCE_KEY,
  VIDEO_PLAYBACK_SETTINGS_EVENT,
  loadVideoPlaybackPreferences,
  type VideoPlaybackPreferences,
} from "./VideoViewerSettings";
import { Icon, type IconName } from "./Icon";
import {
  analyzeVideoVolume,
  cacheVideoVolumeAnalysis,
  createVideoAudioPipeline,
  disposeVideoAudioPipeline,
  getCachedVideoVolumeAnalysis,
  VIDEO_VOLUME_REDUCTION_GAIN,
  type VideoAudioPipeline,
} from "../services/videoVolumeNormalizer";
import "./MediaViewer.css";

const FRAME_SECONDS = 1 / 30;
const SLIDESHOW_INTERVAL_MS = 5_000;
const MAX_GIF_FRAME_COUNT = 250;
const MAX_GIF_FRAME_PIXELS = 20_000_000;
const BOOK_PAGE_CACHE_MAX_EDGE = 1_600;
const BOOK_PAGE_CACHE_CONCURRENCY = 1;
const BOOK_PAGE_CACHE_LOOK_BEHIND = 4;
const BOOK_PAGE_CACHE_LOOK_AHEAD = 12;
const BOOK_PAGE_CACHE_INTERACTION_QUIET_MS = 420;
const BOOK_SEEK_PREVIEW_DEBOUNCE_MS = 100;
const MAX_PDF_PAGE_DISPLAY_CACHE_ENTRIES = 48;
const MAX_BOOK_IMAGE_CACHE_ENTRIES = 18;
const BOOK_WHEEL_COOLDOWN_MS = 260;
const VIDEO_PLAYBACK_SAVE_DEBOUNCE_MS = 180;
const VIEWER_INFO_LAYOUT_KEY = "viewerInfoLayout";
const VIEWER_COLLECTION_PAGE_SIZE = 64;
const VIEWER_COLLECTION_CACHE_MAX_ITEMS = 1_280;
const RECOMMENDATION_COUNT = 6;
const VISUAL_RECOMMENDATION_COUNT = 25;
const IMAGE_ZOOM_MIN = 0.02;
const IMAGE_ZOOM_MAX = 32;
const IMAGE_ZOOM_STEP = 1.2;
const IMAGE_PAN_SPEED = 1.45;
type GifFrame = {
  dataUrl: string;
  durationMs: number;
};

type ViewerRuntimeMetadata = {
  width?: number;
  height?: number;
  durationSeconds?: number;
};

type ScoredMediaRecommendation = {
  item: MediaItem;
  score?: number;
  metric?: "similarity" | "tags";
};

type DecodedImage = {
  displayWidth: number;
  displayHeight: number;
  codedWidth?: number;
  codedHeight?: number;
  duration?: number | null;
  close?: () => void;
};

type GifImageDecoder = {
  tracks: {
    ready: Promise<void>;
    selectedTrack?: { frameCount?: number };
  };
  decode: (options: { frameIndex: number; completeFramesOnly?: boolean }) => Promise<{ image: DecodedImage }>;
  close: () => void;
};

type GifImageDecoderConstructor = new (options: {
  data: ArrayBuffer;
  type: string;
  preferAnimation?: boolean;
}) => GifImageDecoder;

const archivePageSourceCache = new Map<string, Promise<string>>();
const bookImageCache = new Map<string, Promise<HTMLImageElement>>();

function trimOldestCacheEntry<K, V>(cache: Map<K, V>, maxEntries: number) {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function archivePageCacheKey(
  mediaId: string,
  revision: string | undefined,
  pageIndex: number,
): string {
  return `${mediaId}\u0000${revision ?? ""}\u0000${pageIndex}`;
}

async function getCachedArchivePageSource(
  mediaId: string,
  revision: string | undefined,
  pageIndex: number,
): Promise<string> {
  const key = archivePageCacheKey(mediaId, revision, pageIndex);
  const cached = archivePageSourceCache.get(key);
  if (cached) return cached;
  const pending = getArchiveBookPage(mediaId, pageIndex).then((result) => {
    if (result.error || !result.data) {
      throw new Error(result.error ?? "ZIPブックのページを読み込めませんでした。");
    }
    const source = localAssetUrl(result.data);
    if (!source) throw new Error("ZIPブックの画像ページを開けませんでした。");
    return source;
  }).finally(() => {
    // Native disk entries can be evicted. Deduplicate in-flight requests only;
    // every later visit revalidates the path before loading an image.
    if (archivePageSourceCache.get(key) === pending) {
      archivePageSourceCache.delete(key);
    }
  });
  archivePageSourceCache.set(key, pending);
  return pending;
}

async function loadCachedBookImage(source: string): Promise<HTMLImageElement> {
  const cached = bookImageCache.get(source);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("ブックの画像ページを表示できません。"));
    image.src = source;
  }).catch((error: unknown) => {
    bookImageCache.delete(source);
    throw error;
  });
  bookImageCache.set(source, pending);
  trimOldestCacheEntry(bookImageCache, MAX_BOOK_IMAGE_CACHE_ENTRIES);
  return pending;
}

function canvasToBookPageUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("PDFページのキャッシュを作成できませんでした。"));
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, "image/jpeg", 0.9);
  });
}

function waitForBookCacheIdle(): Promise<void> {
  return new Promise((resolve) => {
    const idleWindow = window as Partial<Window>;
    if (idleWindow.requestIdleCallback) {
      idleWindow.requestIdleCallback(() => resolve(), { timeout: 800 });
      return;
    }
    globalThis.setTimeout(resolve, 48);
  });
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function mediaFamilyMatches(current: MediaItem, candidate: MediaItem): boolean {
  if (current.kind === "image" || current.kind === "gif") {
    return candidate.kind === "image" || candidate.kind === "gif";
  }
  if (current.kind === "video") return candidate.kind === "video";
  if (current.kind === "pdf" || current.kind === "archive") {
    return candidate.kind === "pdf" || candidate.kind === "archive";
  }
  return candidate.kind === current.kind;
}

function familyKinds(item: MediaItem): MediaKind[] {
  if (item.kind === "image" || item.kind === "gif") return ["image", "gif"];
  if (item.kind === "video") return ["video"];
  if (item.kind === "pdf" || item.kind === "archive") return ["pdf", "archive"];
  return [item.kind];
}

function relativeFolderPath(item: MediaItem): string | undefined {
  if (item.relativePath === undefined) return undefined;
  const normalized = item.relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

function sameTagScore(current: MediaItem, candidate: MediaItem): number {
  const currentTagIds = new Set(current.tags.map((tag) => tag.id));
  if (currentTagIds.size === 0) return 0;
  return candidate.tags.reduce(
    (score, tag) => score + (currentTagIds.has(tag.id) ? 1 : 0),
    0,
  );
}

function releaseGifFrames(frames: GifFrame[]) {
  frames.forEach((frame) => {
    if (frame.dataUrl.startsWith("blob:")) URL.revokeObjectURL(frame.dataUrl);
  });
}

export type MediaViewerProps = {
  items: MediaItem[];
  currentId: string;
  collection?: {
    query: MediaQuery;
    revision?: number;
    totalCount: number;
    currentIndex: number;
    indexedItems: Array<[number, MediaItem]>;
  };
  onClose: () => void;
  onItemPatch: (mediaId: string, patch: Partial<MediaItem>) => void;
  onRemove: (mediaId: string) => void;
  onCurrentIdChange?: (mediaId: string, item?: MediaItem, index?: number) => void;
  /** Preserve an explicit cross-format/cross-folder input order, such as an OS file-open batch. */
  preserveItemOrder?: boolean;
  /** External request ID: decode selected media before mounting recommendations. */
  prioritizeVisual?: string;
  onVisualReady?: (mediaId: string) => void;
};

type ActionButtonProps = {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
};

function ActionButton({
  icon,
  label,
  onClick,
  active = false,
  danger = false,
  disabled = false,
  busy = false,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      className={[
        "pv-viewer-action",
        active ? "is-active" : "",
        danger ? "is-danger" : "",
        busy ? "is-busy" : "",
      ].filter(Boolean).join(" ")}
      aria-pressed={active || undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      {busy ? <i className="pv-viewer-action-spinner" /> : <Icon name={icon} />}
      <span>{label}</span>
    </button>
  );
}

function IconControl({
  icon,
  label,
  onClick,
  disabled = false,
}: Pick<ActionButtonProps, "icon" | "label" | "onClick" | "disabled">) {
  return (
    <button
      type="button"
      className="pv-viewer-icon-control"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

function fileStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  return (stem || "capture").replace(/[<>:"/\\|?*]/g, "_").slice(0, 80);
}

function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(0, Math.max(0, normalized.lastIndexOf("/"))).toLocaleLowerCase();
}

function resultError(result: { available: boolean; error?: string }, unavailableMessage: string): Error | undefined {
  if (result.error) return new Error(result.error);
  if (!result.available) return new Error(unavailableMessage);
  return undefined;
}

function triggerDownload(dataUrl: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function scrollHorizontalWithWheel(event: React.WheelEvent<HTMLElement>) {
  const target = event.currentTarget;
  if (target.scrollWidth <= target.clientWidth) return;
  const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  if (Math.abs(rawDelta) < 0.1) return;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 34
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? Math.max(240, target.clientWidth * 0.72)
      : 1;
  const normalized = rawDelta * unit;
  const distance = Math.sign(normalized)
    * Math.min(560, Math.max(112, Math.abs(normalized) * 1.8));
  event.preventDefault();
  event.stopPropagation();
  target.scrollLeft += distance;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1_024; index += 1) {
    value /= 1_024;
    unit = units[index];
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function fileExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name);
  return match?.[1]?.toLocaleUpperCase() ?? "—";
}

function useMediaRecommendations(
  item: MediaItem,
  tags: Tag[],
  items: MediaItem[],
  enabled: boolean,
): {
  randomItems: ScoredMediaRecommendation[];
  relatedItems: ScoredMediaRecommendation[];
  vectorLoading: boolean;
  vectorPending: boolean;
  usesVisualVector: boolean;
} {
  const currentWithTags = useMemo(() => ({ ...item, tags }), [item, tags]);
  const fallbackFolderCandidates = useMemo(
    () => items.filter((candidate) =>
      candidate.id !== item.id
      && mediaFamilyMatches(item, candidate)
      && parentPath(candidate.path) === parentPath(item.path)),
    [item, items],
  );
  const [folderPool, setFolderPool] = useState<MediaItem[]>(fallbackFolderCandidates);
  const [tagPool, setTagPool] = useState<MediaItem[]>(items);
  const tagKey = tags.map((tag) => tag.id).sort().join("|");

  useEffect(() => {
    let active = true;
    setFolderPool(fallbackFolderCandidates);
    setTagPool(items);
    if (!enabled) return () => { active = false; };
    const kinds = familyKinds(item);
    const folderPath = relativeFolderPath(item);

    // Let the selected media begin decoding before recommendation queries use
    // SQLite and storage. Closing or switching quickly cancels the work.
    const loadTimer = window.setTimeout(() => {
      if (item.rootId !== undefined && folderPath !== undefined) {
        void listMediaItems({
          rootId: item.rootId,
          folderPath,
          kind: kinds,
          sortBy: "modifiedAt",
          sortDirection: "desc",
          limit: 160,
        }).then((result) => {
          if (!active || result.error || result.data.length === 0) return;
          setFolderPool(result.data);
        });
      }

      const visual = item.kind === "image" || item.kind === "gif";
      if (!visual && tags.length > 0) {
        void Promise.all(tags.slice(0, 4).map((tag) => listMediaItems({
          kind: kinds,
          tagIds: [tag.id],
          sortBy: "modifiedAt",
          sortDirection: "desc",
          limit: 40,
        }))).then((results) => {
          if (!active) return;
          const merged = new Map(items.map((candidate) => [candidate.id, candidate]));
          results.forEach((result) => {
            if (result.error) return;
            result.data.forEach((candidate) => merged.set(candidate.id, candidate));
          });
          setTagPool([...merged.values()]);
        });
      }
    }, 320);

    return () => {
      active = false;
      window.clearTimeout(loadTimer);
    };
  }, [
    fallbackFolderCandidates,
    enabled,
    item,
    items,
    tagKey,
    tags,
  ]);

  const sameFolderCandidates = useMemo(
    () => folderPool.filter((candidate) =>
      candidate.id !== item.id
      && mediaFamilyMatches(item, candidate)
      && parentPath(candidate.path) === parentPath(item.path)),
    [folderPool, item],
  );
  const randomItems = useMemo(
    () => [...sameFolderCandidates]
      .sort((left, right) =>
        stableHash(`${item.id}:random:${left.id}`) - stableHash(`${item.id}:random:${right.id}`))
      .slice(0, RECOMMENDATION_COUNT)
      .map((candidate) => ({ item: candidate })),
    [item.id, sameFolderCandidates],
  );
  const tagRelated = useMemo(
    () => tagPool
      .filter((candidate) =>
        candidate.id !== item.id
        && mediaFamilyMatches(item, candidate))
      .map((candidate) => ({
        item: candidate,
        score: sameTagScore(currentWithTags, candidate),
        metric: "tags" as const,
      }))
      .filter((candidate) => (candidate.score ?? 0) > 0)
      .sort((left, right) =>
        (right.score ?? 0) - (left.score ?? 0)
        || left.item.name.localeCompare(right.item.name, "ja"))
      .slice(0, RECOMMENDATION_COUNT),
    [currentWithTags, item, tagPool],
  );
  const usesVisualVector = item.kind === "image" || item.kind === "gif";
  const [visualRelated, setVisualRelated] = useState<ScoredMediaRecommendation[]>([]);
  const [vectorLoading, setVectorLoading] = useState(usesVisualVector && enabled);
  const [vectorPending, setVectorPending] = useState(false);

  useEffect(() => {
    if (!usesVisualVector || !enabled) {
      setVisualRelated([]);
      setVectorLoading(false);
      setVectorPending(false);
      return;
    }
    let active = true;
    let initialTimer: number | undefined;
    let retryTimer: number | undefined;
    let retryCount = 0;
    setVisualRelated([]);
    setVectorLoading(true);
    setVectorPending(false);

    const loadCachedRecommendations = async () => {
      const result = await getVisualRecommendations(item.id, VISUAL_RECOMMENDATION_COUNT);
      if (!active) return;
      if (!result.error) {
        setVisualRelated(result.data.recommendations.map((recommendation) => ({
          item: recommendation.item,
          score: recommendation.similarity,
          metric: "similarity",
        })));
        setVectorPending(result.data.pending);
      } else {
        setVisualRelated([]);
        setVectorPending(false);
      }
      setVectorLoading(false);

      if (result.available && !result.error && result.data.pending && retryCount < 20) {
        retryCount += 1;
        retryTimer = window.setTimeout(
          () => void loadCachedRecommendations(),
          Math.min(5_000, 1_200 + retryCount * 220),
        );
      }
    };
    initialTimer = window.setTimeout(() => void loadCachedRecommendations(), 480);

    return () => {
      active = false;
      if (initialTimer !== undefined) window.clearTimeout(initialTimer);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [enabled, item.id, item.modifiedAt, usesVisualVector]);

  return {
    randomItems,
    relatedItems: usesVisualVector ? visualRelated : tagRelated,
    vectorLoading,
    vectorPending,
    usesVisualVector,
  };
}

function RecommendationGroup({
  title,
  description,
  recommendations,
  loading = false,
  pending = false,
  onSelect,
}: {
  title: string;
  description: string;
  recommendations: ScoredMediaRecommendation[];
  loading?: boolean;
  pending?: boolean;
  onSelect: (item: MediaItem) => void;
}) {
  return (
    <section className="pv-media-info-section pv-media-recommendations">
      <div className="pv-media-info-section-title">
        <span><Icon name="sparkles" />{title}</span>
      </div>
      <p className="pv-media-recommendation-note">{description}</p>
      {loading
        ? <span className="pv-media-recommendation-loading"><i />画像特徴を比較中…</span>
        : recommendations.length > 0
          ? (
            <div className="pv-media-recommendation-grid">
              {recommendations.map(({ item: candidate, score, metric }) => (
                <button
                  key={candidate.id}
                  type="button"
                  className={metric === "similarity" ? "is-similarity" : undefined}
                  style={metric === "similarity" && score !== undefined
                    ? {
                        "--pv-similarity-hue": `${Math.round(8 + Math.max(0, Math.min(1, score)) * 128)}`,
                        "--pv-similarity-alpha": `${(0.08 + Math.max(0, Math.min(1, score)) * 0.18).toFixed(3)}`,
                      } as React.CSSProperties
                    : undefined}
                  title={candidate.name}
                  onClick={() => onSelect(candidate)}
                >
                  <span className="pv-media-recommendation-visual">
                    <ThumbnailVisual item={candidate} />
                    {metric === "similarity" && score !== undefined && (
                      <em>{Math.max(0, Math.round(score * 100))}%</em>
                    )}
                  </span>
                  <span>
                    <b>{candidate.name}</b>
                    <small>
                      {score === undefined
                        ? mediaTypeLabel(candidate)
                        : metric === "similarity"
                          ? `類似度 ${Math.max(0, Math.round(score * 100))}%`
                          : `共通タグ ${score}件`}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )
          : <em className="pv-media-recommendation-empty">候補はまだありません</em>}
      {pending && (
        <small className="pv-media-recommendation-pending">
          <i />未分析・更新画像をバックグラウンドで補完中
        </small>
      )}
    </section>
  );
}

function MediaInfoSidebar({
  item,
  items,
  tags,
  ageRating,
  favorite,
  runtimeMetadata,
  pageCount,
  pageIndex,
  layout,
  open,
  busy,
  onToggleOpen,
  onLayoutChange,
  onSelect,
  onEditTags,
  onReveal,
}: {
  item: MediaItem;
  items: MediaItem[];
  tags: Tag[];
  ageRating: AgeRating;
  favorite: boolean;
  runtimeMetadata: ViewerRuntimeMetadata;
  pageCount: number;
  pageIndex: number;
  layout: ViewerInfoLayout;
  open: boolean;
  busy: boolean;
  onToggleOpen: () => void;
  onLayoutChange: (layout: ViewerInfoLayout, keepCollapsed?: boolean) => void;
  onSelect: (item: MediaItem) => void;
  onEditTags: () => void;
  onReveal: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [dragTarget, setDragTarget] = useState<ViewerInfoLayout>(layout);
  const [floatingPosition, setFloatingPosition] = useState<{ x: number; y: number }>();
  const panelRef = useRef<HTMLElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const translateTag = useTagTranslations();
  const [tagNavigationTag, setTagNavigationTag] = useState<Tag>();
  const {
    randomItems,
    relatedItems,
    vectorLoading,
    vectorPending,
    usesVisualVector,
  } = useMediaRecommendations(item, tags, items, open);
  const width = runtimeMetadata.width ?? item.width;
  const height = runtimeMetadata.height ?? item.height;
  const duration = runtimeMetadata.durationSeconds ?? item.durationSeconds;
  const aspect = width && height ? `${(width / height).toFixed(3)} : 1` : "—";
  const book = item.kind === "pdf" || item.kind === "archive";
  const sameFolderLabel = item.kind === "video"
    ? "同じフォルダの動画"
    : book
      ? "同じフォルダのブック"
      : "同じフォルダの画像";
  const currentFolderPath = relativeFolderPath(item);

  useEffect(() => {
    setTagNavigationTag(undefined);
  }, [item.id]);

  const handleDragMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    const container = panelRef.current?.parentElement;
    const bounds = container?.getBoundingClientRect();
    const rightEdge = bounds?.right ?? window.innerWidth;
    const next = event.clientX >= rightEdge - 72 ? "sidebar" : "bottomSheet";
    setDragTarget(next);
    if (!open && bounds && next === "bottomSheet") {
      const panelWidth = 176;
      const panelHeight = 42;
      setFloatingPosition({
        x: Math.max(8, Math.min(
          event.clientX - bounds.left - dragOffsetRef.current.x,
          bounds.width - panelWidth - 8,
        )),
        y: Math.max(8, Math.min(
          event.clientY - bounds.top - dragOffsetRef.current.y,
          bounds.height - panelHeight - 8,
        )),
      });
    }
  };

  const finishLayoutDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const bounds = panelRef.current?.parentElement?.getBoundingClientRect();
    const finalTarget: ViewerInfoLayout =
      event.clientX >= (bounds?.right ?? window.innerWidth) - 72 ? "sidebar" : "bottomSheet";
    setDragging(false);
    setDragTarget(finalTarget);
    if (finalTarget !== layout) onLayoutChange(finalTarget, !open);
  };

  const floatingStyle: React.CSSProperties | undefined =
    !open && (layout === "bottomSheet" || (dragging && dragTarget === "bottomSheet"))
      ? floatingPosition
        ? {
            left: floatingPosition.x,
            top: floatingPosition.y,
            right: "auto",
            bottom: "auto",
            transform: "none",
          }
        : undefined
      : undefined;

  return (
    <aside
      ref={panelRef}
      style={floatingStyle}
      className={[
        "pv-media-info-panel",
        layout === "bottomSheet" ? "is-bottom-sheet" : "is-sidebar",
        !open ? "is-collapsed" : "",
        dragging ? "is-dragging" : "",
        dragging ? `drag-target-${dragTarget}` : "",
      ].filter(Boolean).join(" ")}
      aria-label="メディア情報とおすすめ"
    >
      <header>
        <button
          type="button"
          className="pv-media-info-drag-handle"
          aria-label="レコメンドをドラッグして下または右へ移動"
          title="ドラッグして下部／右サイドを切り替え"
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const panelBounds = panelRef.current?.getBoundingClientRect();
            dragOffsetRef.current = panelBounds
              ? {
                  x: Math.max(0, event.clientX - panelBounds.left),
                  y: Math.max(0, event.clientY - panelBounds.top),
                }
              : { x: 88, y: 21 };
            setDragTarget(layout);
            setDragging(true);
          }}
          onPointerMove={handleDragMove}
          onPointerUp={finishLayoutDrag}
          onPointerCancel={() => setDragging(false)}
        >
          <i /><i /><i />
          <span>{dragging ? (dragTarget === "sidebar" ? "右サイドへ移動" : "下部へ移動") : "ドラッグして移動"}</span>
        </button>
        <div>
          <span className="pv-viewer-kicker">DETAILS & RECOMMEND</span>
          <h3>情報とおすすめ</h3>
        </div>
        <button
          type="button"
          className="pv-media-info-sheet-toggle"
          aria-expanded={open}
          aria-label={open ? "情報とレコメンドを閉じる" : "情報とレコメンドを開く"}
          title={open ? "閉じる" : "開く"}
          onClick={onToggleOpen}
        >
          <Icon name={open ? "minus" : "sparkles"} />
        </button>
      </header>
      <div className="pv-media-info-scroll">
        <section className="pv-media-info-overview">
          <div className="pv-media-info-summary">
            <span className={`kind-${item.kind}`}><Icon name={item.kind === "video" ? "video" : book ? "book" : "image"} /></span>
            <div>
              <strong title={item.name}>{item.name}</strong>
              <small>{mediaTypeLabel(item)} · {fileExtension(item.name)}</small>
            </div>
          </div>
          <div className="pv-media-info-badges">
            <span className={`rating-${ageRating.toLocaleLowerCase()}`}>{ratingLabel(ageRating)}</span>
            {favorite && <span className="is-favorite"><Icon name="heart" />お気に入り</span>}
          </div>
        </section>

        <RecommendationGroup
          title={sameFolderLabel}
          description="現在のファイルと同じフォルダからランダムに表示"
          recommendations={randomItems}
          onSelect={onSelect}
        />

        <RecommendationGroup
          title={usesVisualVector ? "似ている画像" : "同じタグの候補"}
          description={usesVisualVector
            ? "ライブラリー全体をMobileNetV3の意味特徴ベクトルで比較（40%超）"
            : "共通するタグが多い順に表示"}
          recommendations={relatedItems}
          loading={usesVisualVector && vectorLoading}
          pending={usesVisualVector && vectorPending}
          onSelect={onSelect}
        />

        <section className="pv-media-info-section">
          <div className="pv-media-info-section-title">
            <span><Icon name="tag" />タグ</span>
            <button type="button" onClick={onEditTags}>編集</button>
          </div>
          <div className="pv-media-info-tags">
            {tags.length > 0
              ? tags.map((tag) => {
                const translatedName = translateTag(tag.name);
                const confidence = tag.source === "ai" && tag.confidence !== undefined
                  ? Math.max(0, Math.min(1, tag.confidence))
                  : undefined;
                return (
                  <button
                    type="button"
                    key={tag.id}
                    className={confidence !== undefined ? "is-ai-confidence" : undefined}
                    style={confidence !== undefined
                      ? { "--pv-tag-confidence": `${Math.round(confidence * 100)}%` } as React.CSSProperties
                      : undefined}
                    title={translatedName !== tag.name ? `${translatedName} (${tag.name})` : tag.name}
                    aria-expanded={tagNavigationTag?.id === tag.id}
                    onClick={() => setTagNavigationTag((current) =>
                      current?.id === tag.id ? undefined : tag)}
                  >
                    <i style={{ backgroundColor: tag.color || "#a77bf3" }} />
                    <span>{translatedName}</span>
                    {confidence !== undefined && (
                      <strong>{Math.round(confidence * 100)}%</strong>
                    )}
                  </button>
                );
              })
              : <em>タグはまだありません</em>}
          </div>
          {tagNavigationTag && (
            <div className="pv-tag-navigation" role="group" aria-label={`${translateTag(tagNavigationTag.name)}のギャラリーを開く`}>
              <div>
                <small>TAG GALLERY</small>
                <strong>「{translateTag(tagNavigationTag.name)}」で絞り込む</strong>
              </div>
              <button
                type="button"
                disabled={!item.rootId || currentFolderPath === undefined}
                onClick={() => openTagGallery({
                  tagId: tagNavigationTag.id,
                  tagName: tagNavigationTag.name,
                  scope: "folder",
                  rootId: item.rootId,
                  folderPath: currentFolderPath,
                })}
              >
                <Icon name="folder" />
                このフォルダー
              </button>
              <button
                type="button"
                onClick={() => openTagGallery({
                  tagId: tagNavigationTag.id,
                  tagName: tagNavigationTag.name,
                  scope: "all",
                })}
              >
                <Icon name="gallery" />
                全フォルダー
              </button>
            </div>
          )}
        </section>

        <section className="pv-media-info-section">
          <div className="pv-media-info-section-title"><span><Icon name="info" />ファイル情報</span></div>
          <dl className="pv-media-info-list">
            <div><dt>ファイル名</dt><dd title={item.name}>{item.name}</dd></div>
            <div><dt>形式</dt><dd>{fileExtension(item.name)}</dd></div>
            <div><dt>MIME</dt><dd>{item.mimeType || "—"}</dd></div>
            <div><dt>ファイルサイズ</dt><dd title={`${item.sizeBytes.toLocaleString("ja-JP")} bytes`}>{formatFileSize(item.sizeBytes)}</dd></div>
            {width && height && <div><dt>寸法</dt><dd>{width.toLocaleString("ja-JP")} × {height.toLocaleString("ja-JP")} px</dd></div>}
            {width && height && <div><dt>アスペクト比</dt><dd>{aspect}</dd></div>}
            {item.kind === "video" && <div><dt>再生時間</dt><dd>{duration ? formatTime(duration) : "—"}</dd></div>}
            {book && <div><dt>ページ</dt><dd>{pageCount > 0 ? `${pageCount.toLocaleString("ja-JP")} ページ` : "取得中"}</dd></div>}
            {book && pageCount > 0 && <div><dt>表示位置</dt><dd>{Math.min(pageCount, pageIndex + 1).toLocaleString("ja-JP")} / {pageCount.toLocaleString("ja-JP")}</dd></div>}
            <div><dt>更新日時</dt><dd>{formatDateTime(item.modifiedAt)}</dd></div>
            <div><dt>登録日時</dt><dd>{formatDateTime(item.importedAt)}</dd></div>
          </dl>
        </section>

        <section className="pv-media-info-section">
          <div className="pv-media-info-section-title"><span><Icon name="folder" />保存場所</span></div>
          {item.rootId && <p className="pv-media-info-root">ライブラリ ID: {item.rootId}</p>}
          {item.relativePath && <p className="pv-media-info-relative" title={item.relativePath}>{item.relativePath}</p>}
          <p className="pv-media-info-path" title={item.path}>{item.path}</p>
          <button
            type="button"
            className="pv-media-info-explorer"
            disabled={busy}
            onClick={onReveal}
          >
            <Icon name="folder" />
            エクスプローラーで表示
            <Icon name="external" />
          </button>
        </section>
      </div>
    </aside>
  );
}

async function persistCapture(dataUrl: string, name: string): Promise<string> {
  const result = await saveCapture(dataUrl, name);
  if (result.error) throw new Error(result.error);
  if (!result.available) {
    triggerDownload(dataUrl, name);
    return "ダウンロード";
  }
  if (!result.data) throw new Error("保存をキャンセルしました。");
  return result.data;
}

function canvasDataUrl(
  source: HTMLImageElement | HTMLVideoElement,
  mimeType: "image/png" | "image/jpeg" = "image/png",
): string {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!width || !height) throw new Error("表示中のメディアをまだ描画できません。");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("キャプチャ用キャンバスを作成できません。");
  context.drawImage(source, 0, 0, width, height);
  return canvas.toDataURL(mimeType, mimeType === "image/jpeg" ? 0.92 : undefined);
}

function canvasesDataUrl(canvases: HTMLCanvasElement[]): string {
  const ready = canvases.filter((canvas) => canvas.width > 0 && canvas.height > 0);
  if (ready.length === 0) throw new Error("ブックページをまだ描画しています。");
  const gap = ready.length > 1 ? 8 : 0;
  const output = document.createElement("canvas");
  output.width = ready.reduce((total, canvas) => total + canvas.width, 0) + gap * (ready.length - 1);
  output.height = Math.max(...ready.map((canvas) => canvas.height));
  const context = output.getContext("2d");
  if (!context) throw new Error("ブックのキャプチャ領域を作成できません。");
  context.fillStyle = "#111018";
  context.fillRect(0, 0, output.width, output.height);
  let left = 0;
  ready.forEach((canvas) => {
    context.drawImage(canvas, left, 0);
    left += canvas.width + gap;
  });
  return output.toDataURL("image/png");
}

function mediaTypeLabel(item: MediaItem): string {
  switch (item.kind) {
    case "image": return "画像";
    case "gif": return "GIF";
    case "video": return "動画";
    case "pdf":
    case "archive": return "本";
    default: return "FILE";
  }
}

function ThumbnailVisual({ item }: { item: MediaItem }) {
  const thumbnail = useCoordinatedThumbnail(
    item.id,
    item.modifiedAt,
    item.thumbnailPath,
    "visible",
  );
  const [archiveCover, setArchiveCover] = useState<string>();
  const directSource = mediaAssetUrl(item);

  useEffect(() => {
    setArchiveCover(undefined);
    if (thumbnail.pending || thumbnail.path || item.kind !== "archive") return;
    let active = true;
    void getArchiveCover(item.id).then((cover) => {
      if (active && cover.data) setArchiveCover(localAssetUrl(cover.data));
    });
    return () => { active = false; };
  }, [item.id, item.kind, thumbnail.path, thumbnail.pending]);

  if (thumbnail.pending) {
    return (
      <span className={`pv-viewer-rail-placeholder kind-${item.kind}`} aria-hidden="true">
        <Icon name={item.kind === "video" ? "video" : item.kind === "pdf" || item.kind === "archive" ? "book" : "image"} />
      </span>
    );
  }
  const thumbnailSource = localAssetUrl(thumbnail.path) ?? archiveCover;
  const source = thumbnailSource ?? directSource;
  if (source && (item.kind === "image" || item.kind === "gif" || thumbnailSource)) {
    return <img src={source} alt="" loading="lazy" draggable={false} />;
  }
  if (source && item.kind === "video") {
    return <VideoPreviewFrame source={source} />;
  }
  return (
    <span className={`pv-viewer-rail-placeholder kind-${item.kind}`} aria-hidden="true">
      <Icon name={item.kind === "video" ? "video" : item.kind === "pdf" || item.kind === "archive" ? "book" : "image"} />
    </span>
  );
}

function VideoPreviewFrame({ source }: { source: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="pv-viewer-rail-placeholder kind-video" aria-hidden="true">
        <Icon name="video" />
      </span>
    );
  }
  return (
    <video
      src={source}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        if (Number.isFinite(video.duration) && video.duration > 0.4) {
          try {
            video.currentTime = Math.min(1, video.duration * 0.12);
          } catch {
            // The first decoded frame remains visible when seeking is unsupported.
          }
        }
      }}
      onError={() => setFailed(true)}
    />
  );
}

const VIEWER_RAIL_CARD_WIDTH = 112;
const VIEWER_RAIL_CARD_GAP = 8;
const VIEWER_RAIL_CARD_STRIDE = VIEWER_RAIL_CARD_WIDTH + VIEWER_RAIL_CARD_GAP;
const VIEWER_RAIL_START_PADDING = 12;
const VIEWER_RAIL_OVERSCAN = 4;

type ViewerRailRange = { start: number; end: number };

function trimViewerCollectionCache(
  items: Map<number, MediaItem>,
  anchors: number[],
): Map<number, MediaItem> {
  if (items.size <= VIEWER_COLLECTION_CACHE_MAX_ITEMS) return items;
  const validAnchors = anchors.filter((anchor) => anchor >= 0);
  const distance = (index: number) => validAnchors.length > 0
    ? Math.min(...validAnchors.map((anchor) => Math.abs(index - anchor)))
    : index;
  return new Map(
    [...items.entries()]
      .sort(([left], [right]) => distance(left) - distance(right))
      .slice(0, VIEWER_COLLECTION_CACHE_MAX_ITEMS),
  );
}

function viewerRailRange(
  itemCount: number,
  scrollLeft: number,
  viewportWidth: number,
): ViewerRailRange {
  if (itemCount <= 0) return { start: 0, end: 0 };
  const firstVisible = Math.max(
    0,
    Math.floor((Math.max(0, scrollLeft) - VIEWER_RAIL_START_PADDING) / VIEWER_RAIL_CARD_STRIDE),
  );
  const lastVisible = Math.min(
    itemCount - 1,
    Math.max(
      firstVisible,
      Math.ceil(
        (Math.max(0, scrollLeft) + Math.max(1, viewportWidth) - VIEWER_RAIL_START_PADDING)
        / VIEWER_RAIL_CARD_STRIDE,
      ),
    ),
  );
  return {
    start: Math.max(0, firstVisible - VIEWER_RAIL_OVERSCAN),
    end: Math.min(itemCount, lastVisible + VIEWER_RAIL_OVERSCAN + 1),
  };
}

function viewerRailInitialRange(itemCount: number, currentIndex: number): ViewerRailRange {
  if (itemCount <= 0) return { start: 0, end: 0 };
  const anchor = Math.max(0, Math.min(itemCount - 1, currentIndex));
  return {
    start: Math.max(0, anchor - VIEWER_RAIL_OVERSCAN),
    end: Math.min(itemCount, anchor + VIEWER_RAIL_OVERSCAN + 1),
  };
}

function MediaThumbnailRail({
  itemCount,
  currentIndex,
  itemAt,
  open,
  onSelect,
  onToggle,
  onVisibleRangeChange,
  includesAllMedia = false,
}: {
  itemCount: number;
  currentIndex: number;
  itemAt: (index: number) => MediaItem | undefined;
  open: boolean;
  onSelect: (mediaId: string, index: number) => void;
  onToggle: () => void;
  onVisibleRangeChange?: (range: ViewerRailRange) => void;
  includesAllMedia?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | undefined>(undefined);
  const pendingScrollLeft = useRef(0);
  const [visibleRange, setVisibleRange] = useState<ViewerRailRange>(() =>
    viewerRailInitialRange(itemCount, currentIndex),
  );
  const trackWidth = Math.max(
    0,
    itemCount * VIEWER_RAIL_CARD_STRIDE - VIEWER_RAIL_CARD_GAP,
  );

  const updateVisibleRange = useCallback((scrollLeft: number, viewportWidth: number) => {
    const next = viewerRailRange(itemCount, scrollLeft, viewportWidth);
    setVisibleRange((current) =>
      current.start === next.start && current.end === next.end ? current : next,
    );
    onVisibleRangeChange?.(next);
  }, [itemCount, onVisibleRangeChange]);

  useEffect(() => {
    if (!open || currentIndex < 0) return;
    const host = scrollRef.current;
    if (!host) return;
    const itemCenter = VIEWER_RAIL_START_PADDING
      + currentIndex * VIEWER_RAIL_CARD_STRIDE
      + VIEWER_RAIL_CARD_WIDTH / 2;
    const nextScrollLeft = Math.max(
      0,
      Math.min(host.scrollWidth - host.clientWidth, itemCenter - host.clientWidth / 2),
    );
    // A direct jump keeps the virtual window and physical position in lock-step
    // when a recommendation selects an item far outside the current viewport.
    host.scrollLeft = nextScrollLeft;
    pendingScrollLeft.current = nextScrollLeft;
    updateVisibleRange(nextScrollLeft, host.clientWidth);
  }, [currentIndex, itemCount, open, updateVisibleRange]);

  useEffect(() => {
    if (!open) return;
    const host = scrollRef.current;
    if (!host) return;
    const update = () => updateVisibleRange(host.scrollLeft, host.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [open, updateVisibleRange]);

  useEffect(() => () => {
    if (scrollFrame.current !== undefined) {
      window.cancelAnimationFrame(scrollFrame.current);
    }
  }, []);

  const visibleIndexes = Array.from(
    { length: Math.max(0, visibleRange.end - visibleRange.start) },
    (_, offset) => visibleRange.start + offset,
  );

  return (
    <nav
      className={`pv-viewer-rail${open ? "" : " is-collapsed"}`}
      aria-label={includesAllMedia ? "ギャラリー内の全メディア一覧" : "同じ種類のメディア一覧"}
    >
      <button
        type="button"
        className="pv-viewer-rail-toggle"
        aria-expanded={open}
        aria-label={open ? "メディア一覧を閉じる" : "メディア一覧を開く"}
        title={open ? "一覧を閉じる" : "一覧を開く"}
        onClick={onToggle}
      >
        <Icon name={open ? "eyeOff" : "eye"} />
        <span>{open ? "一覧を閉じる" : "一覧を開く"}</span>
      </button>
      <div
        ref={scrollRef}
        className="pv-viewer-rail-scroll"
        onWheel={scrollHorizontalWithWheel}
        onScroll={(event) => {
          pendingScrollLeft.current = event.currentTarget.scrollLeft;
          if (scrollFrame.current !== undefined) return;
          const host = event.currentTarget;
          scrollFrame.current = window.requestAnimationFrame(() => {
            scrollFrame.current = undefined;
            updateVisibleRange(pendingScrollLeft.current, host.clientWidth);
          });
        }}
        title="ホイールで一覧を横スクロール"
      >
        <div className="pv-viewer-rail-track" style={{ width: trackWidth }}>
          {visibleIndexes.map((index) => {
            const candidate = itemAt(index);
            const selected = index === currentIndex;
            return (
              <button
                key={candidate?.id ?? `loading-${index}`}
                type="button"
                className={`${selected ? "is-current" : ""}${candidate ? "" : " is-loading"}`}
                aria-current={selected ? "true" : undefined}
                aria-label={candidate
                  ? `${candidate.name}、${mediaTypeLabel(candidate)}、${index + 1} / ${itemCount}`
                  : `メディアを読み込み中、${index + 1} / ${itemCount}`}
                title={candidate?.name ?? "読み込み中…"}
                style={{ left: index * VIEWER_RAIL_CARD_STRIDE }}
                onClick={() => candidate && onSelect(candidate.id, index)}
              >
                <span className="pv-viewer-rail-visual">
                  {candidate
                    ? <ThumbnailVisual item={candidate} />
                    : <span className="pv-viewer-rail-placeholder" aria-hidden="true"><Icon name="gallery" /></span>}
                </span>
                <span className="pv-viewer-rail-name">{candidate?.name ?? "読み込み中…"}</span>
                <b>{candidate ? mediaTypeLabel(candidate) : "LOAD"}</b>
              </button>
            );
          })}
        </div>
      </div>
      <span className="pv-viewer-rail-count">
        {currentIndex >= 0 ? currentIndex + 1 : "—"} / {itemCount.toLocaleString("ja-JP")}
      </span>
    </nav>
  );
}

function GifFramesModal({
  item,
  frames,
  progress,
  error,
  onClose,
}: {
  item: MediaItem;
  frames: GifFrame[];
  progress?: { current: number; total: number };
  error?: string;
  onClose: () => void;
}) {
  const headingId = "pv-gif-frames-title";
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);
  const frameButtonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastFrameWheelAt = useRef(0);
  const safeSelectedFrameIndex = Math.max(0, Math.min(selectedFrameIndex, Math.max(0, frames.length - 1)));
  const selectedFrame = frames[safeSelectedFrameIndex];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!["Escape", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft") {
        setSelectedFrameIndex((current) => Math.max(0, current - 1));
      } else {
        setSelectedFrameIndex((current) => Math.min(Math.max(0, frames.length - 1), current + 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [frames.length, onClose]);

  useEffect(() => {
    if (frames.length === 0) return;
    setSelectedFrameIndex((current) => Math.min(current, frames.length - 1));
  }, [frames.length]);

  useEffect(() => {
    frameButtonRefs.current[safeSelectedFrameIndex]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [safeSelectedFrameIndex]);

  return (
    <div
      className="pv-viewer-submodal pv-gif-frames-modal"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section role="dialog" aria-modal="true" aria-labelledby={headingId} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="pv-viewer-kicker">GIF FRAME PREVIEW</span>
            <h3 id={headingId}>{item.name}</h3>
          </div>
          <IconControl icon="close" label="閉じる" onClick={onClose} />
        </header>
        <div className="pv-gif-feedback">
          <div className="pv-gif-frame-status" role="status" aria-live="polite">
            {progress
              ? <><span><i style={{ width: `${Math.max(2, progress.current / Math.max(1, progress.total) * 100)}%` }} /></span>{progress.current} / {progress.total} コマを展開中…</>
              : frames.length > 0
                ? `${frames.length}コマを展開しました。ウィンドウ右下をドラッグすると表示サイズを変えられます。`
                : "GIFを読み込んでいます…"}
          </div>
          {error && <p className="pv-viewer-error" role="alert">{error}</p>}
        </div>
        <div
          className="pv-gif-frame-stage"
          aria-busy={Boolean(progress)}
          title="ホイールで前後のコマへ移動"
          onWheel={(event) => {
            const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
              ? event.deltaY
              : event.deltaX;
            if (!selectedFrame || Math.abs(delta) < 0.1) return;
            event.preventDefault();
            event.stopPropagation();
            const now = performance.now();
            if (now - lastFrameWheelAt.current < 85) return;
            lastFrameWheelAt.current = now;
            setSelectedFrameIndex((current) =>
              delta > 0
                ? Math.min(frames.length - 1, current + 1)
                : Math.max(0, current - 1));
          }}
        >
          <IconControl
            icon="arrowRight"
            label="前のコマ"
            disabled={!selectedFrame || safeSelectedFrameIndex <= 0}
            onClick={() => setSelectedFrameIndex((current) => Math.max(0, current - 1))}
          />
          <div className="pv-gif-frame-canvas">
            {selectedFrame
              ? <img src={selectedFrame.dataUrl} alt={`${safeSelectedFrameIndex + 1}コマ目`} />
              : <span className="pv-viewer-loading"><i />最初のコマを準備しています…</span>}
            {selectedFrame && (
              <span>{safeSelectedFrameIndex + 1} / {frames.length}</span>
            )}
          </div>
          <IconControl
            icon="arrowRight"
            label="次のコマ"
            disabled={!selectedFrame || safeSelectedFrameIndex >= frames.length - 1}
            onClick={() => setSelectedFrameIndex((current) => Math.min(Math.max(0, frames.length - 1), current + 1))}
          />
        </div>
        <div
          className="pv-gif-frame-strip"
          aria-label="コマ一覧"
          onWheel={scrollHorizontalWithWheel}
          title="ホイールでコマ一覧を横スクロール"
        >
          {frames.map((frame, index) => (
            <button
              key={`${index}-${frame.dataUrl.length}`}
              ref={(element) => { frameButtonRefs.current[index] = element; }}
              type="button"
              className={index === safeSelectedFrameIndex ? "is-current" : ""}
              aria-current={index === safeSelectedFrameIndex ? "true" : undefined}
              aria-label={`${index + 1}コマ目を表示`}
              onClick={() => setSelectedFrameIndex(index)}
            >
              <img src={frame.dataUrl} alt="" />
              <span>{index + 1}</span>
            </button>
          ))}
        </div>
        <footer>
          <span>
            {selectedFrame
              ? `${safeSelectedFrameIndex + 1} / ${frames.length} · ${selectedFrame.durationMs > 0 ? `${Math.round(selectedFrame.durationMs)}ms` : "表示時間不明"}`
              : "コマを準備中"}
          </span>
          <div>
            <button
              type="button"
              className="pv-viewer-secondary"
              onClick={onClose}
            >
              閉じる
            </button>
            <button
              type="button"
              className="pv-viewer-primary"
              disabled={!selectedFrame}
              onClick={() => selectedFrame && triggerDownload(
                selectedFrame.dataUrl,
                `${fileStem(item.name)}_frame_${String(safeSelectedFrameIndex + 1).padStart(4, "0")}.png`,
              )}
            >
              <Icon name="download" />PNG保存
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function TagEditor({
  item,
  onClose,
  onSaved,
}: {
  item: MediaItem;
  onClose: () => void;
  onSaved: (tags: Tag[]) => void;
}) {
  const translateTag = useTagTranslations();
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set(item.tags.map((tag) => tag.id)));
  const [newTag, setNewTag] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void listTags().then((result) => {
      if (!active) return;
      setAvailableTags(result.data);
      setError(result.error);
      setBusy(false);
    });
    return () => { active = false; };
  }, []);

  const toggle = (tagId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(tagId) ? next.delete(tagId) : next.add(tagId);
      return next;
    });
  };

  const createTag = async () => {
    const name = newTag.trim();
    if (!name) return;
    setBusy(true);
    const result = await upsertTag({ name });
    if (result.error || !result.data) {
      setError(result.error ?? "タグを作成できませんでした。");
    } else {
      setAvailableTags((current) => current.some((tag) => tag.id === result.data?.id)
        ? current
        : [...current, result.data as Tag]);
      setSelectedIds((current) => new Set(current).add((result.data as Tag).id));
      setNewTag("");
    }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    const result = await setMediaTags(item.id, [...selectedIds]);
    if (result.error || !result.data) {
      setError(result.error ?? "タグを保存できませんでした。");
      setBusy(false);
      return;
    }
    onSaved(availableTags.filter((tag) => selectedIds.has(tag.id)));
    onClose();
  };

  return (
    <div className="pv-viewer-submodal" role="presentation" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="pv-tag-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="pv-viewer-kicker">TAG EDITOR</span>
            <h3 id="pv-tag-title">タグを編集</h3>
          </div>
          <IconControl icon="close" label="閉じる" onClick={onClose} />
        </header>
        <div className="pv-tag-create">
          <input
            value={newTag}
            onChange={(event) => setNewTag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void createTag();
              }
            }}
            placeholder="新しいタグ名"
            aria-label="新しいタグ名"
          />
          <button type="button" onClick={() => void createTag()} disabled={busy || !newTag.trim()}>
            追加
          </button>
        </div>
        {error && <p className="pv-viewer-error">{error}</p>}
        <div className="pv-tag-options" aria-busy={busy}>
          {busy && availableTags.length === 0
            ? <span className="pv-viewer-loading"><i />タグを読み込み中…</span>
            : availableTags.length === 0
              ? <p>タグはまだありません。</p>
              : availableTags.map((tag) => {
                const translatedName = translateTag(tag.name);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={selectedIds.has(tag.id) ? "is-selected" : ""}
                    aria-pressed={selectedIds.has(tag.id)}
                    title={translatedName !== tag.name ? tag.name : undefined}
                    onClick={() => toggle(tag.id)}
                  >
                    <span style={{ backgroundColor: tag.color || "#a77bf3" }} />
                    {translatedName}
                    {selectedIds.has(tag.id) && <Icon name="check" />}
                  </button>
                );
              })}
        </div>
        <footer>
          <button type="button" className="pv-viewer-secondary" onClick={onClose}>キャンセル</button>
          <button type="button" className="pv-viewer-primary" onClick={() => void save()} disabled={busy}>
            保存
          </button>
        </footer>
      </section>
    </div>
  );
}

function ImageViewer({
  item,
  source,
  imageRef,
  rotation,
  doubleClickZoom,
  shortcutsEnabled,
  onLoadingChange,
  onError,
  onMetadata,
  onContextMenu,
}: {
  item: MediaItem;
  source?: string;
  imageRef: React.RefObject<HTMLImageElement | null>;
  rotation: number;
  doubleClickZoom: boolean;
  shortcutsEnabled: boolean;
  onLoadingChange: (loading: boolean) => void;
  onError: (message: string | undefined) => void;
  onMetadata: (metadata: ViewerRuntimeMetadata) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | undefined>(undefined);
  const panFrameRef = useRef<number | undefined>(undefined);
  const pendingPanRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const [viewport, setViewport] = useState({ zoom: 1, x: 0, y: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const [displaySource, setDisplaySource] = useState(source);
  const [fallbackAttempted, setFallbackAttempted] = useState(false);
  const quarterTurn = Math.abs(rotation) % 180 === 90;
  const displayNaturalWidth = quarterTurn ? naturalSize.height : naturalSize.width;
  const displayNaturalHeight = quarterTurn ? naturalSize.width : naturalSize.height;

  const fitScale = useMemo(() => {
    if (
      stageSize.width <= 0
      || stageSize.height <= 0
      || displayNaturalWidth <= 0
      || displayNaturalHeight <= 0
    ) return 1;
    return Math.min(
      stageSize.width / displayNaturalWidth,
      stageSize.height / displayNaturalHeight,
    );
  }, [displayNaturalHeight, displayNaturalWidth, stageSize.height, stageSize.width]);
  const actualSizeZoom = Math.max(
    IMAGE_ZOOM_MIN,
    Math.min(IMAGE_ZOOM_MAX, 1 / Math.max(0.0001, fitScale)),
  );

  useEffect(() => () => {
    if (panFrameRef.current !== undefined) {
      window.cancelAnimationFrame(panFrameRef.current);
    }
  }, []);

  const clampOffset = useCallback((x: number, y: number, zoom: number) => {
    if (
      stageSize.width <= 0
      || stageSize.height <= 0
      || displayNaturalWidth <= 0
      || displayNaturalHeight <= 0
    ) return { x: 0, y: 0 };
    const fittedWidth = displayNaturalWidth * fitScale;
    const fittedHeight = displayNaturalHeight * fitScale;
    const maxX = Math.max(0, (fittedWidth * zoom - stageSize.width) / 2);
    const maxY = Math.max(0, (fittedHeight * zoom - stageSize.height) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }, [displayNaturalHeight, displayNaturalWidth, fitScale, stageSize.height, stageSize.width]);

  const setZoom = useCallback((
    requestedZoom: number,
    anchor?: { clientX: number; clientY: number },
  ) => {
    setViewport((current) => {
      const zoom = Math.max(IMAGE_ZOOM_MIN, Math.min(IMAGE_ZOOM_MAX, requestedZoom));
      let x = current.x;
      let y = current.y;
      const bounds = stageRef.current?.getBoundingClientRect();
      if (anchor && bounds && current.zoom > 0) {
        const anchorX = anchor.clientX - bounds.left - bounds.width / 2;
        const anchorY = anchor.clientY - bounds.top - bounds.height / 2;
        const ratio = zoom / current.zoom;
        x = anchorX - (anchorX - current.x) * ratio;
        y = anchorY - (anchorY - current.y) * ratio;
      }
      const offset = clampOffset(x, y, zoom);
      return { zoom, ...offset };
    });
  }, [clampOffset]);

  const resetFit = useCallback(() => {
    setViewport({ zoom: 1, x: 0, y: 0 });
  }, []);
  const resetActualSize = useCallback(() => {
    setViewport({
      zoom: actualSizeZoom,
      x: 0,
      y: 0,
    });
  }, [actualSizeZoom]);

  useEffect(() => {
    onError(undefined);
    onLoadingChange(Boolean(source));
    setDisplaySource(source);
    setFallbackAttempted(false);
    setViewport({ zoom: 1, x: 0, y: 0 });
    setNaturalSize({ width: 0, height: 0 });
    setPanning(false);
    dragRef.current = undefined;
  }, [item.id, onError, onLoadingChange, source]);

  useEffect(() => {
    setViewport({ zoom: 1, x: 0, y: 0 });
  }, [rotation]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [source]);

  useEffect(() => {
    setViewport((current) => ({
      ...current,
      ...clampOffset(current.x, current.y, current.zoom),
    }));
  }, [clampOffset]);

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.ctrlKey
        || event.metaKey
        || event.altKey
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.target instanceof HTMLSelectElement
      ) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom(viewport.zoom * IMAGE_ZOOM_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom(viewport.zoom / IMAGE_ZOOM_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        resetFit();
      } else if (event.key === "1") {
        event.preventDefault();
        resetActualSize();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [resetActualSize, resetFit, setZoom, shortcutsEnabled, viewport.zoom]);

  if (!displaySource) return <Unavailable icon="image">画像を開けません。</Unavailable>;
  const displayPercent = Math.max(1, Math.round(fitScale * viewport.zoom * 100));
  const pannable = clampOffset(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, viewport.zoom);
  const canPan = pannable.x > 0 || pannable.y > 0;
  return (
    <div
      ref={stageRef}
      className={[
        "pv-viewer-image-stage",
        canPan ? "is-pannable" : "",
        panning ? "is-panning" : "",
      ].filter(Boolean).join(" ")}
      onContextMenu={onContextMenu}
      onWheel={(event) => {
        event.preventDefault();
        setZoom(
          viewport.zoom * (event.deltaY < 0 ? IMAGE_ZOOM_STEP : 1 / IMAGE_ZOOM_STEP),
          { clientX: event.clientX, clientY: event.clientY },
        );
      }}
      onDoubleClick={() => {
        if (!doubleClickZoom) return;
        if (Math.abs(viewport.zoom - actualSizeZoom) < 0.02) resetFit();
        else resetActualSize();
      }}
      onPointerDown={(event) => {
        if (!canPan || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          originX: viewport.x,
          originY: viewport.y,
        };
        setPanning(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const next = clampOffset(
          drag.originX + (event.clientX - drag.startX) * IMAGE_PAN_SPEED,
          drag.originY + (event.clientY - drag.startY) * IMAGE_PAN_SPEED,
          viewport.zoom,
        );
        pendingPanRef.current = next;
        if (panFrameRef.current === undefined) {
          panFrameRef.current = window.requestAnimationFrame(() => {
            panFrameRef.current = undefined;
            const pending = pendingPanRef.current;
            pendingPanRef.current = undefined;
            if (pending) setViewport((current) => ({ ...current, ...pending }));
          });
        }
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = undefined;
        setPanning(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragRef.current = undefined;
        pendingPanRef.current = undefined;
        setPanning(false);
      }}
      onDragStart={(event) => event.preventDefault()}
    >
      <img
        ref={imageRef}
        src={displaySource}
        alt={item.name}
        crossOrigin="anonymous"
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        style={{
          width: quarterTurn && stageSize.height > 0 ? `${stageSize.height}px` : "100%",
          height: quarterTurn && stageSize.width > 0 ? `${stageSize.width}px` : "100%",
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom}) rotate(${rotation}deg)`,
        }}
        onLoad={(event) => {
          setNaturalSize({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          });
          onMetadata({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          });
          onLoadingChange(false);
        }}
        onError={() => {
          if (!fallbackAttempted) {
            setFallbackAttempted(true);
            onLoadingChange(true);
            void getMediaImagePreview(item.id).then((result) => {
              const fallback = localAssetUrl(result.data ?? undefined);
              if (fallback) {
                setDisplaySource(fallback);
                onError(undefined);
                return;
              }
              onLoadingChange(false);
              onError(result.error ?? "この画像形式をデコードできませんでした。");
            });
            return;
          }
          onLoadingChange(false);
          onError("画像ファイルを読み込めませんでした。ファイルが移動・削除されていないか確認してください。");
        }}
      />
      <div
        className="pv-image-zoom-controls"
        role="toolbar"
        aria-label="画像の拡大縮小"
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="縮小（-）"
          title="縮小（-）"
          onClick={() => setZoom(viewport.zoom / IMAGE_ZOOM_STEP)}
        >
          −
        </button>
        <output title="画像本来の大きさに対する表示倍率">{displayPercent}%</output>
        <button
          type="button"
          aria-label="拡大（+）"
          title="拡大（+）"
          onClick={() => setZoom(viewport.zoom * IMAGE_ZOOM_STEP)}
        >
          ＋
        </button>
        <button type="button" className="is-text" title="等倍表示（1）" onClick={resetActualSize}>
          等倍
        </button>
        <button type="button" className="is-text" title="画面に合わせる（0）" onClick={resetFit}>
          フィット
        </button>
      </div>
    </div>
  );
}

function VideoViewer({
  item,
  source,
  videoRef,
  playbackPreferences,
  onPlaybackPreferencesChange,
  onError,
  onLoadingChange,
  menusHidden,
  onMetadata,
  seekSeconds,
}: {
  item: MediaItem;
  source?: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playbackPreferences: VideoPlaybackPreferences;
  onPlaybackPreferencesChange: (patch: Partial<VideoPlaybackPreferences>) => void;
  onError: (message: string) => void;
  onLoadingChange: (loading: boolean) => void;
  menusHidden: boolean;
  onMetadata: (metadata: ViewerRuntimeMetadata) => void;
  seekSeconds: number;
}) {
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(item.durationSeconds ?? 0);
  const [seeking, setSeeking] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [relativeScrubbing, setRelativeScrubbing] = useState(false);
  const [relativeOffset, setRelativeOffset] = useState(0);
  const [relativeAnchorTime, setRelativeAnchorTime] = useState(0);
  const [relativeTargetTime, setRelativeTargetTime] = useState(0);
  const [volume, setVolume] = useState(playbackPreferences.volume);
  const [muted, setMuted] = useState(playbackPreferences.muted);
  const [autoVolumeReductionActive, setAutoVolumeReductionActive] = useState(false);
  const [wheelFeedback, setWheelFeedback] = useState<{ icon: IconName; text: string }>();
  const [controlsVisible, setControlsVisible] = useState(true);
  const previewRef = useRef<HTMLVideoElement>(null);
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const clickTimerRef = useRef<number | undefined>(undefined);
  const surfacePointers = useRef(new Set<number>());
  const surfacePress = useRef<{ id: number; x: number; y: number; at: number } | undefined>(undefined);
  const surfaceTap = useRef<{ x: number; y: number; at: number; forwards: boolean } | undefined>(undefined);
  const controlsTimerRef = useRef<number | undefined>(undefined);
  const relativeScrubActiveRef = useRef(false);
  const relativeAnchorRef = useRef(0);
  const relativeWasPlayingRef = useRef(false);
  const volumeAnalysisSuppressRef = useRef(false);
  const audioPipelineRef = useRef<VideoAudioPipeline | undefined>(undefined);
  const audioPipelineVideoRef = useRef<HTMLVideoElement | undefined>(undefined);

  useEffect(() => {
    return () => {
      const video = audioPipelineVideoRef.current;
      if (video) disposeVideoAudioPipeline(video);
      audioPipelineRef.current = undefined;
      audioPipelineVideoRef.current = undefined;
    };
  }, [videoRef]);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (controlsTimerRef.current !== undefined) {
      window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = undefined;
    }
    if (menusHidden) {
      controlsTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
        controlsTimerRef.current = undefined;
      }, 2_800);
    }
  }, [menusHidden]);

  useEffect(() => {
    if (clickTimerRef.current !== undefined) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = undefined;
    }
    surfacePress.current = undefined;
    surfaceTap.current = undefined;
    surfacePointers.current.clear();
    setPlaying(false);
    setPosition(0);
    setPreviewTime(0);
    setRelativeScrubbing(false);
    setRelativeOffset(0);
    setRelativeAnchorTime(0);
    setRelativeTargetTime(0);
    relativeScrubActiveRef.current = false;
    relativeAnchorRef.current = 0;
    relativeWasPlayingRef.current = false;
    setDuration(item.durationSeconds ?? 0);
    setVolume(playbackPreferences.volume);
    setMuted(playbackPreferences.muted);
    setAutoVolumeReductionActive(false);
    setWheelFeedback(undefined);
    onLoadingChange(Boolean(source));
  }, [item.durationSeconds, item.id, onLoadingChange, source]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    video.loop = playbackPreferences.loop;
    video.muted = playbackPreferences.muted;
    video.volume = playbackPreferences.volume;
    setMuted(playbackPreferences.muted);
    setVolume(playbackPreferences.volume);
  }, [item.id, playbackPreferences.loop, playbackPreferences.muted, playbackPreferences.volume, source, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && !audioPipelineRef.current) {
      audioPipelineRef.current = createVideoAudioPipeline(video);
      audioPipelineVideoRef.current = video;
    }
    const pipeline = audioPipelineRef.current;
    if (!video || !source || !pipeline) return undefined;
    let active = true;
    const analysisKey = `${item.id}:${item.modifiedAt ?? ""}:${item.sizeBytes}`;
    const originalVolume = video.volume;
    const originalMuted = video.muted;
    const cachedAnalysis = getCachedVideoVolumeAnalysis(analysisKey);
    if (cachedAnalysis) {
      const cachedShouldReduce = cachedAnalysis.shouldReduce;
      setAutoVolumeReductionActive(cachedShouldReduce);
      const cachedVolume = cachedShouldReduce ? VIDEO_VOLUME_REDUCTION_GAIN : originalVolume;
      video.volume = cachedVolume;
      setVolume(cachedVolume);
      pipeline.gain.gain.value = 1;
      return () => {
        active = false;
        video.volume = originalVolume;
        video.muted = originalMuted;
        pipeline.gain.gain.value = 1;
      };
    }
    volumeAnalysisSuppressRef.current = true;
    // Cap audible output at 50% while exposing the raw media signal to the
    // analyser. A muted/zero-volume preference stays silent during analysis.
    pipeline.gain.gain.value = originalMuted || originalVolume <= 0
      ? 0
      : Math.min(originalVolume, VIDEO_VOLUME_REDUCTION_GAIN);
    video.muted = false;
    video.volume = 1;
    void pipeline.context.resume().catch(() => undefined);

    void analyzeVideoVolume(video, pipeline).then((analysis) => {
      if (!active) return;
      const shouldReduce = analysis?.shouldReduce === true;
      if (analysis) cacheVideoVolumeAnalysis(analysisKey, analysis);
      setAutoVolumeReductionActive(shouldReduce);
      const nextVolume = shouldReduce ? VIDEO_VOLUME_REDUCTION_GAIN : originalVolume;
      video.volume = nextVolume;
      video.muted = originalMuted;
      setVolume(nextVolume);
      setMuted(originalMuted);
      pipeline.gain.gain.value = 1;
      volumeAnalysisSuppressRef.current = false;
    }).catch(() => {
      if (!active) return;
      video.volume = originalVolume;
      video.muted = originalMuted;
      setAutoVolumeReductionActive(false);
      setVolume(originalVolume);
      setMuted(originalMuted);
      pipeline.gain.gain.value = 1;
      volumeAnalysisSuppressRef.current = false;
    });

    return () => {
      active = false;
      volumeAnalysisSuppressRef.current = false;
      pipeline.gain.gain.value = 1;
      video.volume = originalVolume;
      video.muted = originalMuted;
    };
  }, [item.id, item.modifiedAt, item.sizeBytes, source, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;
    const startPlayback = () => {
      void video.play().catch(() => {
        // Browser preview may block autoplay with sound. The installed WebView
        // starts from the user's click that opened the viewer.
        setPlaying(false);
      });
    };
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      startPlayback();
      return;
    }
    video.addEventListener("canplay", startPlayback, { once: true });
    return () => video.removeEventListener("canplay", startPlayback);
  }, [item.id, source, videoRef]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
    if (clickTimerRef.current !== undefined) window.clearTimeout(clickTimerRef.current);
    if (controlsTimerRef.current !== undefined) window.clearTimeout(controlsTimerRef.current);
  }, []);

  useEffect(() => {
    if (!menusHidden) {
      if (controlsTimerRef.current !== undefined) window.clearTimeout(controlsTimerRef.current);
      controlsTimerRef.current = undefined;
      setControlsVisible(true);
      return;
    }
    revealControls();
  }, [item.id, menusHidden, revealControls]);

  useEffect(() => {
    if (!seeking || !previewRef.current || !Number.isFinite(previewRef.current.duration)) return;
    previewRef.current.currentTime = Math.min(previewTime, previewRef.current.duration || previewTime);
  }, [previewTime, seeking]);

  const showWheelFeedback = (icon: IconName, text: string) => {
    setWheelFeedback({ icon, text });
    if (feedbackTimerRef.current !== undefined) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setWheelFeedback(undefined), 900);
  };

  const seekBy = (seconds: number, frameStep = false): number | undefined => {
    const video = videoRef.current;
    if (!video) return undefined;
    if (frameStep) {
      video.pause();
      setPlaying(false);
    }
    const next = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : duration, video.currentTime + seconds));
    video.currentTime = next;
    setPosition(next);
    return next;
  };

  const seekTo = (nextValue: number) => {
    const video = videoRef.current;
    const safeDuration = Number.isFinite(video?.duration) ? video?.duration ?? duration : duration;
    const next = Math.max(0, Math.min(Math.max(0, safeDuration), nextValue));
    setPreviewTime(next);
    setPosition(next);
    if (video) video.currentTime = next;
    if (previewRef.current && Number.isFinite(previewRef.current.duration)) {
      previewRef.current.currentTime = Math.min(next, previewRef.current.duration || next);
    }
  };

  const beginRelativeScrub = () => {
    const video = videoRef.current;
    if (!video || relativeScrubActiveRef.current) return Boolean(video);
    const anchor = video.currentTime;
    relativeScrubActiveRef.current = true;
    relativeAnchorRef.current = anchor;
    relativeWasPlayingRef.current = !video.paused;
    video.pause();
    setPlaying(false);
    setRelativeScrubbing(true);
    setRelativeOffset(0);
    setRelativeAnchorTime(anchor);
    setRelativeTargetTime(anchor);
    return true;
  };

  const updateRelativeScrub = (requestedOffset: number) => {
    const video = videoRef.current;
    if (!video) return;
    if (!relativeScrubActiveRef.current && !beginRelativeScrub()) return;
    const offset = Math.max(-60, Math.min(60, requestedOffset));
    const safeDuration = Number.isFinite(video.duration) ? video.duration : duration;
    const target = Math.max(0, Math.min(Math.max(0, safeDuration), relativeAnchorRef.current + offset));
    setRelativeOffset(offset);
    setRelativeTargetTime(target);
    setPosition(target);
    video.currentTime = target;
  };

  const finishRelativeScrub = (cancelled = false) => {
    const video = videoRef.current;
    if (!video || !relativeScrubActiveRef.current) return;
    const anchor = relativeAnchorRef.current;
    const target = cancelled ? anchor : video.currentTime;
    if (cancelled) {
      video.currentTime = anchor;
      setPosition(anchor);
    } else {
      const appliedOffset = target - anchor;
      if (Math.abs(appliedOffset) >= FRAME_SECONDS / 2) {
        showWheelFeedback(
          appliedOffset > 0 ? "forward10" : "rewind10",
          `${formatSignedSeconds(appliedOffset)} · ${formatTime(target)}`,
        );
      }
    }
    const shouldResume = relativeWasPlayingRef.current;
    relativeScrubActiveRef.current = false;
    relativeWasPlayingRef.current = false;
    setRelativeScrubbing(false);
    setRelativeOffset(0);
    setRelativeAnchorTime(target);
    setRelativeTargetTime(target);
    if (shouldResume) {
      void video.play().catch(() => setPlaying(false));
    }
  };

  const handleRelativeScrubKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && relativeScrubActiveRef.current) {
      event.preventDefault();
      finishRelativeScrub(true);
      return;
    }
    let seconds: number | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      seconds = event.shiftKey ? -1 : -FRAME_SECONDS;
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      seconds = event.shiftKey ? 1 : FRAME_SECONDS;
    } else if (event.key === "PageDown") {
      seconds = -10;
    } else if (event.key === "PageUp") {
      seconds = 10;
    } else if (event.key === "Home") {
      seconds = -60;
    } else if (event.key === "End") {
      seconds = 60;
    }
    if (seconds === undefined) return;
    event.preventDefault();
    const next = seekBy(seconds, true);
    if (next !== undefined) {
      showWheelFeedback(
        seconds > 0 ? "forward10" : "rewind10",
        `${formatSignedSeconds(seconds)} · ${formatTime(next)}`,
      );
    }
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return false;
    try {
      if (video.paused) await video.play();
      else video.pause();
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : "動画を再生できません。");
      return false;
    }
  };

  const handleVolumeWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.deltaY) return;
    event.preventDefault();
    event.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    const next = Math.max(0, Math.min(1, video.volume + (event.deltaY < 0 ? 0.05 : -0.05)));
    const nextMuted = next <= 0;
    video.volume = next;
    video.muted = nextMuted;
    setMuted(nextMuted);
    setVolume(next);
    onPlaybackPreferencesChange({ volume: next, muted: nextMuted });
    showWheelFeedback(next <= 0 ? "volumeOff" : "volume", `音量 ${Math.round(next * 100)}%`);
  };

  const changeVolume = (nextValue: number) => {
    const video = videoRef.current;
    const next = Math.max(0, Math.min(1, nextValue));
    const nextMuted = next <= 0;
    setVolume(next);
    setMuted(nextMuted);
    if (video) {
      video.volume = next;
      video.muted = nextMuted;
    }
    onPlaybackPreferencesChange({ volume: next, muted: nextMuted });
  };

  const toggleMuted = () => {
    const video = videoRef.current;
    const next = !muted;
    const nextVolume = !next && volume <= 0
      ? DEFAULT_VIDEO_PLAYBACK_PREFERENCES.volume
      : volume;
    setVolume(nextVolume);
    setMuted(next);
    if (video) {
      video.volume = nextVolume;
      video.muted = next;
    }
    onPlaybackPreferencesChange({ volume: nextVolume, muted: next });
  };

  const handleSeekWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.deltaY) return;
    event.preventDefault();
    event.stopPropagation();
    const seconds = event.deltaY < 0 ? 5 : -5;
    const next = seekBy(seconds);
    if (next !== undefined) {
      showWheelFeedback(seconds > 0 ? "forward10" : "rewind10", `${seconds > 0 ? "+" : ""}${seconds}秒 · ${formatTime(next)}`);
    }
  };

  const toggleSurfacePlayback = () => {
    const willPlay = Boolean(videoRef.current?.paused);
    void togglePlayback().then((succeeded) => {
      if (succeeded) showWheelFeedback(willPlay ? "play" : "pause", willPlay ? "再生" : "一時停止");
    });
  };

  const cancelSurfaceTap = () => {
    surfacePress.current = undefined;
    surfaceTap.current = undefined;
    if (clickTimerRef.current !== undefined) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = undefined;
    }
  };

  const handleSurfacePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    surfacePointers.current.add(event.pointerId);
    if (!event.isPrimary || surfacePointers.current.size > 1) {
      cancelSurfaceTap();
      return;
    }
    surfacePress.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleSurfacePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    surfacePointers.current.delete(event.pointerId);
    const press = surfacePress.current;
    surfacePress.current = undefined;
    if (!press || press.id !== event.pointerId) return;
    const now = performance.now();
    if (now - press.at > 450 || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 14) {
      cancelSurfaceTap();
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const forwards = event.clientX - bounds.left >= bounds.width / 2;
    const previous = surfaceTap.current;
    if (previous && now - previous.at <= 450 && previous.forwards === forwards
      && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 48) {
      cancelSurfaceTap();
      const seconds = forwards ? seekSeconds : -seekSeconds;
      const next = seekBy(seconds);
      if (next !== undefined) showWheelFeedback(
        forwards ? "forward10" : "rewind10", `${formatSignedSeconds(seconds)} · ${formatTime(next)}`,
      );
      return;
    }
    // Recognize mouse, pen and touch from their actual pointer events. Some
    // WebViews never emit dblclick for touch; compatibility clicks are ignored.
    if (previous) { cancelSurfaceTap(); toggleSurfacePlayback(); }
    surfaceTap.current = { x: event.clientX, y: event.clientY, at: now, forwards };
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = undefined;
      surfaceTap.current = undefined;
      toggleSurfacePlayback();
    }, 450);
  };

  if (!source) return <Unavailable icon="video">動画を開けません。</Unavailable>;
  return (
    <div
      className={`pv-viewer-video-stage${menusHidden ? " menus-hidden" : ""}`}
      onPointerMove={revealControls}
      onPointerDown={revealControls}
    >
      <div
        className="pv-video-surface"
        onWheel={handleVolumeWheel}
        role="button"
        tabIndex={0}
        aria-label={`動画再生面。左右をダブルタップで${seekSeconds}秒移動`}
        onPointerDown={handleSurfacePointerDown}
        onPointerMove={(event) => {
          const press = surfacePress.current;
          if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 14) cancelSurfaceTap();
        }}
        onPointerUp={handleSurfacePointerUp}
        onPointerCancel={(event) => { surfacePointers.current.delete(event.pointerId); cancelSurfaceTap(); }}
        onClick={(event) => { if (event.detail === 0) toggleSurfacePlayback(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) { cancelSurfaceTap(); toggleSurfacePlayback(); }
          }
        }}
        title={`クリックで再生・停止／左右をダブルタップで${seekSeconds}秒移動／ホイールで音量調整`}
      >
        <video
          ref={videoRef}
          src={source}
          controls={false}
          autoPlay
          loop={playbackPreferences.loop}
          muted={playbackPreferences.muted}
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onVolumeChange={(event) => {
            if (volumeAnalysisSuppressRef.current) return;
            setVolume(event.currentTarget.volume);
            setMuted(event.currentTarget.muted);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => {
            const loadedDuration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0;
            setDuration(loadedDuration);
            onMetadata({
              width: event.currentTarget.videoWidth,
              height: event.currentTarget.videoHeight,
              durationSeconds: loadedDuration,
            });
            onLoadingChange(false);
          }}
          onDurationChange={(event) => {
            const loadedDuration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0;
            setDuration(loadedDuration);
            onMetadata({
              width: event.currentTarget.videoWidth || undefined,
              height: event.currentTarget.videoHeight || undefined,
              durationSeconds: loadedDuration,
            });
          }}
          onError={() => {
            onLoadingChange(false);
            onError("動画ファイルを読み込めませんでした。対応コーデックまたはファイルの場所を確認してください。");
          }}
        >
          この動画形式は再生できません。
        </video>
        {wheelFeedback && (
          <div className="pv-video-wheel-feedback" role="status" aria-live="polite">
            <Icon name={wheelFeedback.icon} />
            <b>{wheelFeedback.text}</b>
          </div>
        )}
      </div>
      <div
        className={`pv-video-controls${menusHidden && !controlsVisible ? " controls-hidden" : ""}`}
        onPointerMove={revealControls}
      >
        <div className="pv-video-seek" onWheel={handleSeekWheel} title="ホイールで5秒ずつ移動">
          {seeking && (
            <div
              className="pv-video-seek-preview"
              style={{ left: `clamp(88px, ${duration > 0 ? previewTime / duration * 100 : 0}%, calc(100% - 88px))` }}
              aria-hidden="true"
            >
              <video ref={previewRef} src={source} muted playsInline preload="metadata" />
              <span>{formatTime(previewTime)}</span>
            </div>
          )}
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.01)}
            step={0.01}
            value={Math.min(position, Math.max(duration, 0.01))}
            aria-label="動画の再生位置"
            aria-valuetext={`${formatTime(position)} / ${formatTime(duration)}`}
            style={{ "--pv-seek-progress": `${duration > 0 ? position / duration * 100 : 0}%` } as React.CSSProperties}
            onPointerDown={() => {
              setSeeking(true);
              setPreviewTime(position);
            }}
            onPointerUp={(event) => {
              seekTo(Number(event.currentTarget.value));
              setSeeking(false);
            }}
            onPointerCancel={() => setSeeking(false)}
            onFocus={() => {
              setSeeking(true);
              setPreviewTime(position);
            }}
            onBlur={() => setSeeking(false)}
            onChange={(event) => seekTo(Number(event.currentTarget.value))}
          />
        </div>
        <div className={`pv-video-relative-scrub${relativeScrubbing ? " is-active" : ""}`}>
          <div className="pv-video-relative-scrub-heading">
            <span>
              フレームスクラブ
              <small>中央から最大±60秒</small>
            </span>
            <output aria-live="polite">
              <b>{relativeScrubbing ? formatSignedSeconds(relativeTargetTime - relativeAnchorTime) : "±0.00秒"}</b>
              <span>{relativeScrubbing ? `プレビュー ${formatTime(relativeTargetTime)}` : `現在 ${formatTime(position)}`}</span>
            </output>
          </div>
          <div className="pv-video-relative-scrub-track">
            <small>−60秒</small>
            <input
              type="range"
              min={-60}
              max={60}
              step={FRAME_SECONDS}
              value={relativeScrubbing ? relativeOffset : 0}
              aria-label="現在位置を基準に動画を前後へ移動"
              aria-valuetext={
                relativeScrubbing
                  ? `${formatSignedSeconds(relativeTargetTime - relativeAnchorTime)}、移動先 ${formatTime(relativeTargetTime)}`
                  : `現在位置 ${formatTime(position)}、中央`
              }
              title="中央からドラッグして最大60秒移動。矢印キーで1コマ、Shift＋矢印で1秒移動"
              style={{
                "--pv-relative-start": `${Math.min(50, (relativeOffset + 60) / 120 * 100)}%`,
                "--pv-relative-end": `${Math.max(50, (relativeOffset + 60) / 120 * 100)}%`,
              } as React.CSSProperties}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                beginRelativeScrub();
              }}
              onPointerUp={(event) => {
                updateRelativeScrub(Number(event.currentTarget.value));
                finishRelativeScrub();
              }}
              onPointerCancel={() => finishRelativeScrub(true)}
              onChange={(event) => {
                const nextOffset = Number(event.currentTarget.value);
                if (relativeScrubActiveRef.current) {
                  updateRelativeScrub(nextOffset);
                  return;
                }
                if (beginRelativeScrub()) {
                  updateRelativeScrub(nextOffset);
                  finishRelativeScrub();
                }
              }}
              onKeyDown={handleRelativeScrubKeyDown}
            />
            <i aria-hidden="true" />
            <small>+60秒</small>
          </div>
        </div>
        <div className="pv-video-transport" aria-label="動画操作">
          <IconControl icon="rewind10" label="10秒戻る" onClick={() => seekBy(-10)} />
          <IconControl icon="stepBack" label="1コマ戻る" onClick={() => seekBy(-FRAME_SECONDS, true)} />
          <button type="button" className="pv-video-play" onClick={() => void togglePlayback()} aria-label={playing ? "一時停止" : "再生"}>
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <IconControl icon="stepForward" label="1コマ進む" onClick={() => seekBy(FRAME_SECONDS, true)} />
          <IconControl icon="forward10" label="10秒進む" onClick={() => seekBy(10)} />
          <span>{formatTime(position)} / {formatTime(duration)}</span>
          <div className="pv-video-volume">
            <button
              type="button"
              aria-label={muted ? "ミュートを解除" : "ミュート"}
              title={muted ? "ミュートを解除" : "ミュート"}
              onClick={toggleMuted}
            >
              <Icon name={muted || volume <= 0 ? "volumeOff" : "volume"} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              aria-label="音量"
              aria-valuetext={muted ? "ミュート" : `${Math.round(volume * 100)}%`}
              style={{ "--pv-volume-progress": `${volume * 100}%` } as React.CSSProperties}
              onChange={(event) => changeVolume(Number(event.currentTarget.value))}
            />
            <small title={autoVolumeReductionActive ? "大きな音量を検出したため、再生ゲインを50%から開始しています" : undefined}>
              {muted ? "消音" : `${Math.round(volume * 100)}%`}
              {autoVolumeReductionActive && !muted ? " · 自動調整" : ""}
            </small>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "00:00.00";
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function formatSignedSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || Math.abs(seconds) < 0.005) return "±0.00秒";
  const sign = seconds > 0 ? "+" : "−";
  return `${sign}${Math.abs(seconds).toFixed(2)}秒`;
}

function Unavailable({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="pv-viewer-unavailable">
      <Icon name={icon} />
      <strong>{children}</strong>
    </div>
  );
}

function BookViewer({
  item,
  pageIndex,
  onPageIndexChange,
  canvasRefs,
  onPageCountChange,
  onLoadingChange,
  onError,
  viewMode,
  binding,
  menusHidden,
  seekAnchors,
  onSeekStart,
}: {
  item: MediaItem;
  pageIndex: number;
  onPageIndexChange: (page: number) => void;
  canvasRefs: React.MutableRefObject<(HTMLCanvasElement | null)[]>;
  onPageCountChange: (count: number) => void;
  onLoadingChange: (loading: boolean) => void;
  onError: (message: string | undefined) => void;
  viewMode: BookViewMode;
  binding: BookBinding;
  menusHidden: boolean;
  seekAnchors: number[];
  onSeekStart: (page: number) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy>();
  const [pageCount, setPageCount] = useState(Math.max(0, item.pageCount ?? 0));
  const [stageSize, setStageSize] = useState({ width: 900, height: 700 });
  const pdfPageCacheRef = useRef<Map<number, Promise<PDFPageProxy>>>(new Map());
  const pageDisplayCacheRef = useRef<Map<number, Promise<string>>>(new Map());
  const pageDisplayObjectUrlsRef = useRef<Map<number, string>>(new Map());
  const pagePreviewCacheRef = useRef<Map<number, string>>(new Map());
  const bookCacheGenerationRef = useRef(0);
  const initialPageDrawnRef = useRef(false);
  const previewGenerationRef = useRef(0);
  const seekPointerActiveRef = useRef(false);
  const lastWheelAtRef = useRef(0);
  const lastBookInteractionAtRef = useRef(performance.now());
  const [seeking, setSeeking] = useState(false);
  const [seekPreviewPage, setSeekPreviewPage] = useState(pageIndex);
  const [seekPreviewSource, setSeekPreviewSource] = useState<string>();
  const [seekPreviewLoading, setSeekPreviewLoading] = useState(false);

  const displayedPages = useMemo(() => {
    if (pageCount <= 0) return [];
    const clamped = Math.max(0, Math.min(pageIndex, pageCount - 1));
    if (viewMode === "single") return [clamped];
    const anchor = Math.floor(clamped / 2) * 2;
    const pages = [anchor, anchor + 1].filter((candidate) => candidate < pageCount);
    return binding === "right" ? pages.reverse() : pages;
  }, [binding, pageCount, pageIndex, viewMode]);
  const displayedPageKey = displayedPages.join(",");

  const getPdfPage = useCallback((bookPage: number): Promise<PDFPageProxy> => {
    if (!pdfDocument) return Promise.reject(new Error("PDFを読み込んでいます。"));
    const cached = pdfPageCacheRef.current.get(bookPage);
    if (cached) return cached;
    const pending = pdfDocument.getPage(bookPage + 1).catch((error: unknown) => {
      pdfPageCacheRef.current.delete(bookPage);
      throw error;
    });
    pdfPageCacheRef.current.set(bookPage, pending);
    return pending;
  }, [pdfDocument]);

  const getDisplayPageSource = useCallback((bookPage: number): Promise<string> => {
    if (item.kind === "archive") return getCachedArchivePageSource(item.id, item.modifiedAt, bookPage);
    const cached = pageDisplayCacheRef.current.get(bookPage);
    if (cached) {
      pageDisplayCacheRef.current.delete(bookPage);
      pageDisplayCacheRef.current.set(bookPage, cached);
      const cachedSource = pageDisplayObjectUrlsRef.current.get(bookPage);
      if (cachedSource) {
        pageDisplayObjectUrlsRef.current.delete(bookPage);
        pageDisplayObjectUrlsRef.current.set(bookPage, cachedSource);
      }
      return cached;
    }
    const generation = bookCacheGenerationRef.current;
    let pending: Promise<string>;
    pending = (async () => {
      const page = await getPdfPage(bookPage);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(
          0.25,
          Math.min(2.5, BOOK_PAGE_CACHE_MAX_EDGE / Math.max(baseViewport.width, baseViewport.height, 1)),
        );
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        await page.render({ canvas, viewport }).promise;
        const source = await canvasToBookPageUrl(canvas);
        if (bookCacheGenerationRef.current !== generation) {
          URL.revokeObjectURL(source);
          throw new Error("ブックのキャッシュ処理を中止しました。");
        }
        pageDisplayObjectUrlsRef.current.set(bookPage, source);
        while (pageDisplayObjectUrlsRef.current.size > MAX_PDF_PAGE_DISPLAY_CACHE_ENTRIES) {
          const oldest = pageDisplayObjectUrlsRef.current.entries().next().value as [number, string] | undefined;
          if (!oldest) break;
          const [oldestPage, oldestSource] = oldest;
          pageDisplayObjectUrlsRef.current.delete(oldestPage);
          pageDisplayCacheRef.current.delete(oldestPage);
          pagePreviewCacheRef.current.delete(oldestPage);
          URL.revokeObjectURL(oldestSource);
        }
        return source;
      } finally {
        pdfPageCacheRef.current.delete(bookPage);
      }
    })().catch((error: unknown) => {
      if (pageDisplayCacheRef.current.get(bookPage) === pending) {
        pageDisplayCacheRef.current.delete(bookPage);
      }
      throw error;
    });
    pageDisplayCacheRef.current.set(bookPage, pending);
    return pending;
  }, [getPdfPage, item.id, item.kind, item.modifiedAt]);

  const getPagePreviewSource = useCallback(async (bookPage: number): Promise<string> => {
    if (item.kind === "archive") return getDisplayPageSource(bookPage);
    const cached = pagePreviewCacheRef.current.get(bookPage);
    if (cached) {
      pagePreviewCacheRef.current.delete(bookPage);
      pagePreviewCacheRef.current.set(bookPage, cached);
      return cached;
    }

    const previewSource = await getDisplayPageSource(bookPage);
    pagePreviewCacheRef.current.set(bookPage, previewSource);
    return previewSource;
  }, [getDisplayPageSource, item.kind]);

  useEffect(() => {
    setPageCount(Math.max(0, item.pageCount ?? 0));
    setPdfDocument(undefined);
    bookCacheGenerationRef.current += 1;
    pdfPageCacheRef.current.clear();
    pageDisplayCacheRef.current.clear();
    pageDisplayObjectUrlsRef.current.forEach((source) => URL.revokeObjectURL(source));
    pageDisplayObjectUrlsRef.current.clear();
    pagePreviewCacheRef.current.clear();
    initialPageDrawnRef.current = false;
    previewGenerationRef.current += 1;
    seekPointerActiveRef.current = false;
    setSeeking(false);
    setSeekPreviewPage(0);
    setSeekPreviewSource(undefined);
    onPageIndexChange(0);
    onError(undefined);
  }, [canvasRefs, item.id, item.pageCount, onError, onPageIndexChange]);

  useEffect(() => () => {
    bookCacheGenerationRef.current += 1;
    pageDisplayObjectUrlsRef.current.forEach((source) => URL.revokeObjectURL(source));
    pageDisplayObjectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    pdfPageCacheRef.current.clear();
  }, [pdfDocument]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const next = { width: stage.clientWidth, height: stage.clientHeight };
      setStageSize((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    update();
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [item.id]);

  useEffect(() => {
    let active = true;
    if (item.kind !== "archive") return;
    onLoadingChange(true);
    void getArchiveBookInfo(item.id).then((result) => {
      if (!active) return;
      if (result.error || !result.data) {
        onError(result.error ?? "ZIPブックの情報を読み込めませんでした。");
      } else {
        setPageCount(result.data.pageCount);
        onPageCountChange(result.data.pageCount);
        if (result.data.pageCount === 0) onLoadingChange(false);
      }
      if (result.error || !result.data) onLoadingChange(false);
    });
    return () => { active = false; };
  }, [item.id, item.kind, onError, onLoadingChange, onPageCountChange]);

  useEffect(() => {
    if (item.kind !== "pdf") return;
    const source = localAssetUrl(item.path);
    if (!source) {
      onError("PDFファイルを開けません。");
      onLoadingChange(false);
      return;
    }
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    onLoadingChange(true);
    onError(undefined);
    void import("pdfjs-dist").then(async ({ GlobalWorkerOptions, getDocument: loadDocument }) => {
      if (!active) return;
      GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      task = loadDocument({ url: source });
      const document = await task.promise;
      if (!active) return;
      setPdfDocument(document);
      setPageCount(document.numPages);
      onPageCountChange(document.numPages);
      if (document.numPages === 0) onLoadingChange(false);
    }).catch((error: unknown) => {
      if (active) {
        onLoadingChange(false);
        onError(error instanceof Error ? error.message : "PDFを読み込めませんでした。");
      }
    });
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [item.id, item.kind, item.path, onError, onLoadingChange, onPageCountChange]);

  useEffect(() => {
    if (pageCount <= 0 || displayedPages.length === 0) return;
    let active = true;
    onError(undefined);

    const slotWidth = Math.max(
      180,
      (Math.max(360, stageSize.width) - 48 - Math.max(0, displayedPages.length - 1) * 10) / displayedPages.length,
    );
    const slotHeight = Math.max(260, stageSize.height - 48);

    const drawPage = async (bookPage: number, canvas: HTMLCanvasElement) => {
      const source = await getDisplayPageSource(bookPage);
      const image = await loadCachedBookImage(source);
      if (!active) return;
      const fitScale = Math.min(
        slotWidth / image.naturalWidth,
        slotHeight / image.naturalHeight,
        item.kind === "archive" ? 1.5 : 1,
      );
      const cssWidth = Math.max(1, Math.floor(image.naturalWidth * fitScale));
      const cssHeight = Math.max(1, Math.floor(image.naturalHeight * fitScale));
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(cssWidth * outputScale));
      canvas.height = Math.max(1, Math.floor(cssHeight * outputScale));
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("ブックページの描画領域を作成できません。");
      context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);
      context.drawImage(image, 0, 0, cssWidth, cssHeight);
      canvas.dataset.bookPage = String(bookPage);
    };

    const render = async () => {
      await Promise.all(displayedPages.map(async (bookPage, slot) => {
        const canvas = canvasRefs.current[slot];
        if (!canvas) return;
        await drawPage(bookPage, canvas);
      }));
      if (active && !initialPageDrawnRef.current) {
        initialPageDrawnRef.current = true;
        onLoadingChange(false);
      }
    };

    if (item.kind === "archive" || pdfDocument) {
      void render().catch((renderError: unknown) => {
        if (!active) return;
        onLoadingChange(false);
        onError(renderError instanceof Error ? renderError.message : "ブックページを描画できませんでした。");
      });
    }
    return () => {
      active = false;
    };
  }, [
    canvasRefs,
    displayedPageKey,
    displayedPages,
    getDisplayPageSource,
    item.kind,
    onError,
    onLoadingChange,
    pageCount,
    pdfDocument,
    stageSize.height,
    stageSize.width,
  ]);

  useEffect(() => {
    if (!seeking || pageCount <= 0) {
      setSeekPreviewLoading(false);
      return;
    }
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    const targetPage = Math.max(0, Math.min(pageCount - 1, seekPreviewPage));
    const cachedPreview = pagePreviewCacheRef.current.get(targetPage);
    setSeekPreviewSource(cachedPreview);
    if (cachedPreview) {
      setSeekPreviewLoading(false);
      return;
    }
    setSeekPreviewLoading(true);
    const timer = window.setTimeout(() => {
      if (previewGenerationRef.current !== generation) return;
      void getPagePreviewSource(targetPage).then((previewSource) => {
        if (previewGenerationRef.current !== generation) return;
        setSeekPreviewSource(previewSource);
        setSeekPreviewLoading(false);
      }).catch(() => {
        if (previewGenerationRef.current !== generation) return;
        setSeekPreviewSource(undefined);
        setSeekPreviewLoading(false);
      });
    }, BOOK_SEEK_PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      if (previewGenerationRef.current === generation) previewGenerationRef.current += 1;
    };
  }, [getPagePreviewSource, pageCount, seeking, seekPreviewPage]);

  useEffect(() => {
    if (pageCount <= 0 || (item.kind === "pdf" && !pdfDocument)) return;
    let active = true;
    let cursor = 0;
    const firstPage = Math.max(0, pageIndex - BOOK_PAGE_CACHE_LOOK_BEHIND);
    const lastPage = Math.min(pageCount - 1, pageIndex + BOOK_PAGE_CACHE_LOOK_AHEAD);
    const pages = Array.from(
      { length: lastPage - firstPage + 1 },
      (_, offset) => firstPage + offset,
    ).sort((left, right) => Math.abs(left - pageIndex) - Math.abs(right - pageIndex));
    const waitForInteractionQuiet = async () => {
      while (active) {
        const quietFor = performance.now() - lastBookInteractionAtRef.current;
        if (quietFor >= BOOK_PAGE_CACHE_INTERACTION_QUIET_MS) return;
        await new Promise<void>((resolve) => window.setTimeout(
          resolve,
          BOOK_PAGE_CACHE_INTERACTION_QUIET_MS - quietFor,
        ));
      }
    };

    if (item.kind === "archive") {
      const cacheArchiveWindow = async () => {
        // Let the visible page finish first. The native batch then sees its
        // cache hit and opens/indexes the ZIP only once for the remaining window.
        await Promise.allSettled(displayedPages.map(getPagePreviewSource));
        await waitForInteractionQuiet();
        await waitForBookCacheIdle();
        if (!active) return;
        await precacheArchiveBookPages(item.id, pages);
      };
      void cacheArchiveWindow();
      return () => { active = false; };
    }

    const worker = async () => {
      while (active && cursor < pages.length) {
        await waitForInteractionQuiet();
        await waitForBookCacheIdle();
        if (!active) return;
        const bookPage = pages[cursor];
        cursor += 1;
        try {
          await getPagePreviewSource(bookPage);
        } catch {
          // Individual corrupt pages must not stop the remaining book cache.
        }
      }
    };
    const workerCount = Math.min(BOOK_PAGE_CACHE_CONCURRENCY, pages.length);
    void Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
    return () => { active = false; };
  }, [displayedPages, getPagePreviewSource, item.id, item.kind, item.modifiedAt, pageCount, pageIndex, pdfDocument]);

  const commitSeekPage = (requestedPage: number) => {
    if (pageCount <= 0) return;
    lastBookInteractionAtRef.current = performance.now();
    const clamped = Math.max(0, Math.min(pageCount - 1, requestedPage));
    const next = viewMode === "spread" ? Math.floor(clamped / 2) * 2 : clamped;
    onPageIndexChange(next);
    setSeekPreviewPage(next);
  };

  const handleBookWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const delta = event.deltaY || event.deltaX;
    if (Math.abs(delta) < 2) return;
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastWheelAtRef.current < BOOK_WHEEL_COOLDOWN_MS) return;
    lastWheelAtRef.current = now;
    const step = viewMode === "spread" ? 2 : 1;
    commitSeekPage(pageIndex + (delta > 0 ? step : -step));
  };

  return (
    <div className={`pv-book-stage is-${viewMode} binding-${binding}${menusHidden ? " menus-hidden" : ""}`}>
      <div
        className="pv-book-page-scroll"
        ref={stageRef}
        onWheel={handleBookWheel}
        title="ホイールでページを移動"
      >
        <div className="pv-book-spread" aria-label={`${item.name}のページ`}>
          {displayedPages.map((bookPage, slot) => (
            <figure key={slot}>
              <canvas
                ref={(element) => { canvasRefs.current[slot] = element; }}
                aria-label={`${item.name} ${bookPage + 1}ページ`}
              />
              <figcaption>{bookPage + 1}</figcaption>
            </figure>
          ))}
        </div>
        {pageCount === 0 && <Unavailable icon="book">ブックを読み込んでいます。</Unavailable>}
      </div>
      <div className="pv-book-page-seek">
        {seeking && (
          <div
            className="pv-book-seek-preview"
            style={{ left: `clamp(66px, ${bookSeekPosition(seekPreviewPage, pageCount, binding)}%, calc(100% - 66px))` }}
            aria-hidden="true"
          >
            <div>
              {seekPreviewSource
                ? <img src={seekPreviewSource} alt="" />
                : <span className="pv-book-preview-loading"><i />{seekPreviewLoading ? "読込中" : "プレビューなし"}</span>}
            </div>
            <b>{seekPreviewPage + 1} / {pageCount}</b>
          </div>
        )}
        <span>{pageCount > 0 ? (binding === "right" ? pageCount : 1) : "—"}</span>
        <div className="pv-book-seek-track">
          <input
            type="range"
            dir={binding === "right" ? "rtl" : "ltr"}
            min={0}
            max={Math.max(0, pageCount - 1)}
            step={1}
            value={seeking ? seekPreviewPage : Math.min(pageIndex, Math.max(0, pageCount - 1))}
            disabled={pageCount <= 1}
            aria-label="ブックのページ位置"
            aria-valuetext={`${pageCount > 0 ? (seeking ? seekPreviewPage : pageIndex) + 1 : 0}ページ / 全${pageCount}ページ`}
            style={{
              "--pv-seek-progress": `${pageCount > 1 ? (seeking ? seekPreviewPage : pageIndex) / (pageCount - 1) * 100 : 0}%`,
            } as React.CSSProperties}
            onKeyDown={(event) => {
              const next = bookSeekKeyPage(event.key, pageIndex, pageCount, binding, viewMode === "spread" ? 2 : 1);
              if (next === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              commitSeekPage(next);
            }}
            onPointerDown={() => {
              seekPointerActiveRef.current = true;
              setSeekPreviewPage(pageIndex);
              setSeeking(true);
              onSeekStart(pageIndex);
            }}
            onPointerUp={(event) => {
              const next = Number(event.currentTarget.value);
              seekPointerActiveRef.current = false;
              setSeeking(false);
              commitSeekPage(next);
            }}
            onPointerCancel={() => {
              seekPointerActiveRef.current = false;
              setSeeking(false);
            }}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              setSeekPreviewPage(next);
              if (!seekPointerActiveRef.current) commitSeekPage(next);
            }}
            onWheel={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          />
          {pageCount > 1 && seekAnchors.map((anchor, index) => (
            <button
              key={`${anchor}-${index}`}
              type="button"
              className="pv-book-seek-anchor"
              style={{ left: `${bookSeekPosition(anchor, pageCount, binding)}%` }}
              title={`${anchor + 1}ページへ戻る`}
              aria-label={`シークアンカー ${anchor + 1}ページへ戻る`}
              onClick={() => commitSeekPage(anchor)}
            >
              <span>{anchor + 1}</span>
            </button>
          ))}
        </div>
        <span>{pageCount > 0 ? (binding === "right" ? 1 : pageCount) : "—"}</span>
      </div>
    </div>
  );
}

export function MediaViewer({
  items,
  currentId,
  collection,
  onClose,
  onItemPatch,
  onRemove,
  onCurrentIdChange,
  preserveItemOrder = false,
  prioritizeVisual,
  onVisualReady,
}: MediaViewerProps) {
  const [activeId, setActiveId] = useState(currentId);
  const [paintedId, setPaintedId] = useState<string>();
  const surroundingsReady = !prioritizeVisual || paintedId === activeId;
  const visualReadyCallback = useRef(onVisualReady);
  visualReadyCallback.current = onVisualReady;
  const priorityRef = useRef(prioritizeVisual);
  priorityRef.current = prioritizeVisual;
  const paintFrames = useRef<number[]>([]);
  const translateTag = useTagTranslations(surroundingsReady);
  const [recommendationItems, setRecommendationItems] = useState<MediaItem[]>([]);
  const collectionKey = collection ? JSON.stringify([collection.query, collection.revision]) : "";
  const [collectionItems, setCollectionItems] = useState<Map<number, MediaItem>>(
    () => new Map(collection?.indexedItems ?? []),
  );
  const collectionItemsRef = useRef(collectionItems);
  const collectionGenerationRef = useRef(0);
  const collectionPageRequestsRef = useRef(new Map<string, Promise<MediaItem[]>>());
  const [activeCollectionIndex, setActiveCollectionIndex] = useState(
    collection?.currentIndex ?? -1,
  );
  const activeCollectionIndexRef = useRef(activeCollectionIndex);
  const collectionRailItems = useMemo(() => {
    const merged = new Map(collectionItems);
    collection?.indexedItems.forEach(([index, candidate]) => merged.set(index, candidate));
    return merged;
  }, [collection?.indexedItems, collectionItems]);
  const availableItems = useMemo(() => {
    const merged = new Map<string, MediaItem>();
    recommendationItems.forEach((candidate) => merged.set(candidate.id, candidate));
    collectionRailItems.forEach((candidate) => merged.set(candidate.id, candidate));
    items.forEach((candidate) => merged.set(candidate.id, candidate));
    return [...merged.values()];
  }, [collectionRailItems, items, recommendationItems]);
  const item = availableItems.find((candidate) => candidate.id === activeId);
  const viewerShellRef = useRef<HTMLElement>(null);
  const viewerBackdropRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const bookCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [favorite, setFavoriteState] = useState(item?.isFavorite ?? false);
  const [ageRating, setAgeRatingState] = useState<AgeRating>(item?.ageRating ?? "UNRATED");
  const [tags, setTags] = useState<Tag[]>(item?.tags ?? []);
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [slideshow, setSlideshow] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(item?.pageCount ?? 0);
  const [bookmarks, setBookmarks] = useState<number[]>([]);
  const [bookViewMode, setBookViewMode] = useState<BookViewMode>("spread");
  const [bookBinding, setBookBinding] = useState<BookBinding>("right");
  const [seekAnchorsEnabled, setSeekAnchorsEnabled] = useState(true);
  const [maxSeekAnchors, setMaxSeekAnchors] = useState(3);
  const [seekAnchors, setSeekAnchors] = useState<number[]>([]);
  const [rotation, setRotation] = useState(0);
  const [showBookSettings, setShowBookSettings] = useState(false);
  const [showBookmarkList, setShowBookmarkList] = useState(false);
  const [showGifFrames, setShowGifFrames] = useState(false);
  const [gifFrames, setGifFrames] = useState<GifFrame[]>([]);
  const gifFramesRef = useRef<GifFrame[]>([]);
  const gifDecodeGeneration = useRef(0);
  const ascii2dGeneration = useRef(0);
  const [gifFrameProgress, setGifFrameProgress] = useState<{ current: number; total: number }>();
  const [gifFrameError, setGifFrameError] = useState<string>();
  const [ascii2dStatus, setAscii2dStatus] = useState<string>();
  const [loading, setLoading] = useState(false);
  const handleMediaLoading = useCallback((next: boolean) => {
    setLoading(next);
    paintFrames.current.forEach(cancelAnimationFrame);
    paintFrames.current = [];
    if (next || !priorityRef.current) return;
    // The load/error callback precedes paint. Yield two frames before any
    // folder queries or recommendation work can compete with that first frame.
    paintFrames.current.push(requestAnimationFrame(() => {
      paintFrames.current.push(requestAnimationFrame(() => {
        paintFrames.current = [];
        setPaintedId(activeId);
      }));
    }));
  }, [activeId]);
  useEffect(() => () => {
    paintFrames.current.forEach(cancelAnimationFrame);
    paintFrames.current = [];
  }, [activeId]);
  useEffect(() => {
    // Reopening the same already-painted file must release the new request too;
    // its unchanged img source will not necessarily emit another load event.
    if (prioritizeVisual && paintedId === activeId) visualReadyCallback.current?.(activeId);
  }, [activeId, paintedId, prioritizeVisual]);
  const [busyAction, setBusyAction] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const { isFullscreen, changeFullscreen } = useViewerFullscreen(viewerShellRef);
  const menusHidden = isFullscreen;
  const [runtimeMetadata, setRuntimeMetadata] = useState<ViewerRuntimeMetadata>({});
  const [infoLayout, setInfoLayout] = useState<ViewerInfoLayout>("sidebar");
  const [recommendSheetOpen, setRecommendSheetOpen] = useState(true);
  const [viewerRailOpen, setViewerRailOpen] = useState(true);
  const [imageContextMenu, setImageContextMenu] = useState<{ x: number; y: number }>();
  const [videoPlaybackPreferences, setVideoPlaybackPreferences] = useState<VideoPlaybackPreferences>(
    DEFAULT_VIDEO_PLAYBACK_PREFERENCES,
  );
  const videoPlaybackPreferencesRef = useRef<VideoPlaybackPreferences>(
    DEFAULT_VIDEO_PLAYBACK_PREFERENCES,
  );
  const pendingVideoPlaybackPreferencesRef = useRef<VideoPlaybackPreferences | undefined>(undefined);
  const videoPlaybackSaveTimerRef = useRef<number | undefined>(undefined);
  const [viewerControlPreferences, setViewerControlPreferences] = useState<ViewerControlPreferences>(
    DEFAULT_VIEWER_CONTROL_PREFERENCES,
  );
  const collectionQuery = collection?.query;
  const collectionTotalCount = collection?.totalCount ?? 0;

  useEffect(() => {
    activeCollectionIndexRef.current = activeCollectionIndex;
  }, [activeCollectionIndex]);

  useEffect(() => {
    collectionGenerationRef.current += 1;
    collectionPageRequestsRef.current.clear();
    const nextItems = new Map(collection?.indexedItems ?? []);
    collectionItemsRef.current = nextItems;
    setCollectionItems(nextItems);
    const nextIndex = collection?.currentIndex ?? -1;
    activeCollectionIndexRef.current = nextIndex;
    setActiveCollectionIndex(nextIndex);
  }, [collectionKey]);

  useEffect(() => {
    if (!collection) return;
    let changed = false;
    const next = new Map(collectionItemsRef.current);
    collection.indexedItems.forEach(([index, candidate]) => {
      if (next.get(index) === candidate) return;
      next.set(index, candidate);
      changed = true;
    });
    if (changed) {
      const trimmed = trimViewerCollectionCache(next, [
        activeCollectionIndexRef.current,
        collection.currentIndex,
      ]);
      collectionItemsRef.current = trimmed;
      setCollectionItems(trimmed);
    }
    if (currentId === activeId && collection.currentIndex !== activeCollectionIndexRef.current) {
      activeCollectionIndexRef.current = collection.currentIndex;
      setActiveCollectionIndex(collection.currentIndex);
    }
  }, [activeId, collection, currentId]);

  useEffect(() => () => {
    collectionGenerationRef.current += 1;
    collectionPageRequestsRef.current.clear();
  }, []);

  const loadCollectionPage = useCallback(async (page: number): Promise<MediaItem[]> => {
    if (!collectionQuery || collectionTotalCount <= 0) return [];
    const safePage = Math.max(0, page);
    const offset = safePage * VIEWER_COLLECTION_PAGE_SIZE;
    if (offset >= collectionTotalCount) return [];
    const end = Math.min(collectionTotalCount, offset + VIEWER_COLLECTION_PAGE_SIZE);
    const cached: MediaItem[] = [];
    let complete = true;
    for (let index = offset; index < end; index += 1) {
      const candidate = collectionItemsRef.current.get(index);
      if (!candidate) {
        complete = false;
        break;
      }
      cached.push(candidate);
    }
    if (complete) return cached;

    const requestKey = `${collectionKey}:${safePage}`;
    const existing = collectionPageRequestsRef.current.get(requestKey);
    if (existing) return existing;
    const generation = collectionGenerationRef.current;
    const request = listMediaItems({
      ...collectionQuery,
      includeDateGroups: false,
      limit: VIEWER_COLLECTION_PAGE_SIZE,
      offset,
    }, { fresh: true }).then((result) => {
      if (generation !== collectionGenerationRef.current) return [];
      if (result.error) throw new Error(result.error);
      const next = new Map(collectionItemsRef.current);
      result.data.forEach((candidate, itemOffset) => {
        next.set(offset + itemOffset, candidate);
      });
      const trimmed = trimViewerCollectionCache(next, [
        activeCollectionIndexRef.current,
        offset + Math.floor(result.data.length / 2),
      ]);
      collectionItemsRef.current = trimmed;
      setCollectionItems(trimmed);
      return result.data;
    }).finally(() => {
      collectionPageRequestsRef.current.delete(requestKey);
    });
    collectionPageRequestsRef.current.set(requestKey, request);
    return request;
  }, [collectionKey, collectionQuery, collectionTotalCount]);

  const ensureCollectionRange = useCallback((range: ViewerRailRange) => {
    if (!collectionQuery || collectionTotalCount <= 0 || range.end <= range.start) return;
    const firstPage = Math.floor(range.start / VIEWER_COLLECTION_PAGE_SIZE);
    const lastPage = Math.floor((Math.min(collectionTotalCount, range.end) - 1) / VIEWER_COLLECTION_PAGE_SIZE);
    void Promise.all(
      Array.from(
        { length: lastPage - firstPage + 1 },
        (_, offset) => loadCollectionPage(firstPage + offset),
      ),
    ).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "メディア一覧を読み込めませんでした。");
    });
  }, [collectionQuery, collectionTotalCount, loadCollectionPage]);

  const loadCollectionItem = useCallback(async (index: number) => {
    const cached = collectionItemsRef.current.get(index);
    if (cached) return cached;
    await loadCollectionPage(Math.floor(index / VIEWER_COLLECTION_PAGE_SIZE));
    return collectionItemsRef.current.get(index);
  }, [loadCollectionPage]);

  const source = item ? mediaAssetUrl(item) : undefined;
  const imageItems = useMemo(() => availableItems.filter((candidate) => candidate.kind === "image" || candidate.kind === "gif"), [availableItems]);
  const videoItems = useMemo(() => availableItems.filter((candidate) => candidate.kind === "video"), [availableItems]);
  const bookItems = useMemo(() => {
    if (!item || (item.kind !== "pdf" && item.kind !== "archive")) return [];
    const folder = parentPath(item.path);
    const sameFolder = availableItems.filter((candidate) =>
      (candidate.kind === "pdf" || candidate.kind === "archive") && parentPath(candidate.path) === folder);
    return sameFolder.length > 0 ? sameFolder : availableItems.filter((candidate) => candidate.kind === "pdf" || candidate.kind === "archive");
  }, [availableItems, item]);
  const viewerRailItems = useMemo(() => {
    if (!item) return [];
    if (preserveItemOrder) return items;
    if (item.kind === "image" || item.kind === "gif") return imageItems;
    if (item.kind === "video") return videoItems;
    if (item.kind === "pdf" || item.kind === "archive") return bookItems;
    return [];
  }, [bookItems, imageItems, item, items, preserveItemOrder, videoItems]);
  const currentBookIndex = item ? bookItems.findIndex((candidate) => candidate.id === item.id) : -1;
  const updateRuntimeMetadata = useCallback((patch: ViewerRuntimeMetadata) => {
    setRuntimeMetadata((current) => ({ ...current, ...patch }));
  }, []);

  const changeActive = useCallback((nextId: string, nextCollectionIndex?: number) => {
    setActiveId(nextId);
    if (collection && nextCollectionIndex !== undefined) {
      activeCollectionIndexRef.current = nextCollectionIndex;
      setActiveCollectionIndex(nextCollectionIndex);
    }
    setError(undefined);
    setMessage(undefined);
    setPageIndex(0);
    setSeekAnchors([]);
    setRotation(0);
    setSlideshow(false);
    setShowBookSettings(false);
    setShowBookmarkList(false);
    setShowGifFrames(false);
    gifDecodeGeneration.current += 1;
    releaseGifFrames(gifFramesRef.current);
    gifFramesRef.current = [];
    setGifFrames([]);
    setGifFrameProgress(undefined);
    setGifFrameError(undefined);
    ascii2dGeneration.current += 1;
    setAscii2dStatus(undefined);
    if (collection && nextCollectionIndex !== undefined) {
      const nextItem = collectionItemsRef.current.get(nextCollectionIndex)
        ?? availableItems.find((candidate) => candidate.id === nextId);
      onCurrentIdChange?.(nextId, nextItem, nextCollectionIndex);
    } else if (items.some((candidate) => candidate.id === nextId)) {
      onCurrentIdChange?.(nextId);
    }
  }, [availableItems, collection, items, onCurrentIdChange]);

  const viewerRailIncludesAllMedia = Boolean(collection);
  const viewerRailItemCount = viewerRailIncludesAllMedia
    ? collectionTotalCount
    : viewerRailItems.length;
  const viewerRailCurrentIndex = viewerRailIncludesAllMedia
    ? activeCollectionIndex
    : viewerRailItems.findIndex((candidate) => candidate.id === activeId);
  const viewerRailItemAt = useCallback((index: number) => (
    viewerRailIncludesAllMedia ? collectionRailItems.get(index) : viewerRailItems[index]
  ), [collectionRailItems, viewerRailIncludesAllMedia, viewerRailItems]);
  const selectViewerRailItem = useCallback((mediaId: string, index: number) => {
    changeActive(mediaId, viewerRailIncludesAllMedia ? index : undefined);
  }, [changeActive, viewerRailIncludesAllMedia]);

  const selectRecommendation = useCallback((candidate: MediaItem) => {
    setRecommendationItems((current) => {
      const existing = current.findIndex((item) => item.id === candidate.id);
      if (existing < 0) return [...current, candidate];
      const next = [...current];
      next[existing] = candidate;
      return next;
    });
    changeActive(candidate.id);
  }, [changeActive]);

  const patchViewerItem = useCallback((mediaId: string, patch: Partial<MediaItem>) => {
    setRecommendationItems((current) => current.map((candidate) =>
      candidate.id === mediaId ? { ...candidate, ...patch } : candidate));
    const next = new Map(collectionItemsRef.current);
    let collectionChanged = false;
    next.forEach((candidate, index) => {
      if (candidate.id !== mediaId) return;
      next.set(index, { ...candidate, ...patch });
      collectionChanged = true;
    });
    if (collectionChanged) {
      collectionItemsRef.current = next;
      setCollectionItems(next);
    }
    onItemPatch(mediaId, patch);
  }, [onItemPatch]);

  const closeGifFrames = useCallback(() => {
    gifDecodeGeneration.current += 1;
    releaseGifFrames(gifFramesRef.current);
    gifFramesRef.current = [];
    setGifFrames([]);
    setGifFrameProgress(undefined);
    setShowGifFrames(false);
  }, []);

  useEffect(() => setActiveId(currentId), [currentId]);

  useEffect(() => {
    if (!imageContextMenu) return;
    const close = () => setImageContextMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [imageContextMenu]);

  useEffect(() => {
    if (!surroundingsReady) return;
    let active = true;
    void getJsonPreference<ViewerInfoLayout>(
      VIEWER_INFO_LAYOUT_KEY,
      "sidebar",
    ).then((result) => {
      if (!active) return;
      const nextLayout = result.data === "bottomSheet" ? "bottomSheet" : "sidebar";
      setInfoLayout(nextLayout);
      setRecommendSheetOpen(nextLayout === "sidebar");
    });
    return () => { active = false; };
  }, [surroundingsReady]);

  useEffect(() => {
    if (!surroundingsReady) return;
    let active = true;
    void loadViewerControlPreferences().then((preferences) => {
      if (active) setViewerControlPreferences(preferences);
    });
    const handleSettings = (event: Event) => {
      const detail = (event as CustomEvent<ViewerControlPreferences>).detail;
      if (detail) setViewerControlPreferences(detail);
    };
    window.addEventListener(VIEWER_CONTROL_SETTINGS_EVENT, handleSettings);
    return () => {
      active = false;
      window.removeEventListener(VIEWER_CONTROL_SETTINGS_EVENT, handleSettings);
    };
  }, [surroundingsReady]);

  const moveInfoLayout = useCallback((
    nextLayout: ViewerInfoLayout,
    keepCollapsed = false,
  ) => {
    if (nextLayout === infoLayout) return;
    const previous = infoLayout;
    setInfoLayout(nextLayout);
    setRecommendSheetOpen(!keepCollapsed);
    void setJsonPreference(VIEWER_INFO_LAYOUT_KEY, nextLayout).then((result) => {
      if (!result.data || result.error) {
        setInfoLayout(previous);
        setError(result.error ?? "レコメンドの表示位置を保存できませんでした。");
        return;
      }
      window.dispatchEvent(new CustomEvent("pixvault:viewer-info-layout", {
        detail: nextLayout,
      }));
    });
  }, [infoLayout]);

  useEffect(() => {
    if (!surroundingsReady && item?.kind !== "video") return;
    let active = true;
    void loadVideoPlaybackPreferences().then((preferences) => {
      if (active) {
        videoPlaybackPreferencesRef.current = preferences;
        setVideoPlaybackPreferences(preferences);
      }
    });
    const handleSettings = (event: Event) => {
      const detail = (event as CustomEvent<VideoPlaybackPreferences>).detail;
      if (detail) {
        videoPlaybackPreferencesRef.current = detail;
        setVideoPlaybackPreferences(detail);
      }
    };
    window.addEventListener(VIDEO_PLAYBACK_SETTINGS_EVENT, handleSettings);
    return () => {
      active = false;
      window.removeEventListener(VIDEO_PLAYBACK_SETTINGS_EVENT, handleSettings);
    };
  }, [surroundingsReady, item?.kind]);

  const rememberVideoPlaybackPreferences = useCallback((
    patch: Partial<VideoPlaybackPreferences>,
  ) => {
    const next: VideoPlaybackPreferences = {
      ...videoPlaybackPreferencesRef.current,
      ...patch,
      volume: Math.max(0, Math.min(
        1,
        patch.volume ?? videoPlaybackPreferencesRef.current.volume,
      )),
    };
    videoPlaybackPreferencesRef.current = next;
    pendingVideoPlaybackPreferencesRef.current = next;
    setVideoPlaybackPreferences(next);
    if (videoPlaybackSaveTimerRef.current !== undefined) {
      window.clearTimeout(videoPlaybackSaveTimerRef.current);
    }
    videoPlaybackSaveTimerRef.current = window.setTimeout(() => {
      videoPlaybackSaveTimerRef.current = undefined;
      const pending = pendingVideoPlaybackPreferencesRef.current;
      pendingVideoPlaybackPreferencesRef.current = undefined;
      if (!pending) return;
      void setJsonPreference(VIDEO_PLAYBACK_PREFERENCE_KEY, pending).then((result) => {
        if (!result.data || result.error) {
          setError(result.error ?? "動画の音量を保存できませんでした。");
        }
      });
    }, VIDEO_PLAYBACK_SAVE_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => {
    if (videoPlaybackSaveTimerRef.current !== undefined) {
      window.clearTimeout(videoPlaybackSaveTimerRef.current);
    }
    const pending = pendingVideoPlaybackPreferencesRef.current;
    pendingVideoPlaybackPreferencesRef.current = undefined;
    if (pending) void setJsonPreference(VIDEO_PLAYBACK_PREFERENCE_KEY, pending);
  }, []);

  useEffect(() => {
    const handleNavigateBack = (event: Event) => {
      const detail = (event as CustomEvent<{ handled?: boolean }>).detail;
      if (detail) detail.handled = true;
      event.preventDefault();
      if (showGifFrames) closeGifFrames();
      else if (showTagEditor) setShowTagEditor(false);
      else if (showBookmarkList) setShowBookmarkList(false);
      else if (showBookSettings) setShowBookSettings(false);
      else if (infoLayout === "bottomSheet" && recommendSheetOpen) setRecommendSheetOpen(false);
      else onClose();
    };
    window.addEventListener("pixvault:navigate-back", handleNavigateBack);
    return () => window.removeEventListener("pixvault:navigate-back", handleNavigateBack);
  }, [
    closeGifFrames,
    infoLayout,
    onClose,
    recommendSheetOpen,
    showBookmarkList,
    showBookSettings,
    showGifFrames,
    showTagEditor,
  ]);

  useEffect(() => () => {
    gifDecodeGeneration.current += 1;
    ascii2dGeneration.current += 1;
    releaseGifFrames(gifFramesRef.current);
    gifFramesRef.current = [];
  }, []);

  useEffect(() => {
    if (isFullscreen) { setShowBookSettings(false); setShowBookmarkList(false); }
  }, [isFullscreen]);

  useEffect(() => {
    if (!surroundingsReady && item?.kind !== "pdf" && item?.kind !== "archive") return;
    let active = true;
    void loadBookViewerSettings().then((settings) => {
      if (!active) return;
      setBookViewMode(settings.viewMode);
      setBookBinding(settings.binding);
      setSeekAnchorsEnabled(settings.seekAnchorsEnabled);
      setMaxSeekAnchors(settings.maxSeekAnchors);
    });
    const handleSettings = (event: Event) => {
      const patch = (event as CustomEvent<Partial<BookViewerSettingsValue>>).detail;
      if (patch.viewMode) {
        setBookViewMode(patch.viewMode);
        if (patch.viewMode === "spread") setPageIndex((current) => Math.floor(current / 2) * 2);
      }
      if (patch.binding) setBookBinding(patch.binding);
      if (typeof patch.seekAnchorsEnabled === "boolean") {
        setSeekAnchorsEnabled(patch.seekAnchorsEnabled);
        if (!patch.seekAnchorsEnabled) setSeekAnchors([]);
      }
      if (typeof patch.maxSeekAnchors === "number") {
        const nextMaximum = Math.max(1, Math.min(5, Math.round(patch.maxSeekAnchors)));
        setMaxSeekAnchors(nextMaximum);
        setSeekAnchors((current) => current.slice(0, nextMaximum));
      }
    };
    window.addEventListener(BOOK_VIEWER_SETTINGS_EVENT, handleSettings);
    return () => {
      active = false;
      window.removeEventListener(BOOK_VIEWER_SETTINGS_EVENT, handleSettings);
    };
  }, [surroundingsReady, item?.kind]);

  useEffect(() => {
    if (!item) return;
    setFavoriteState(item.isFavorite);
    setAgeRatingState(item.ageRating);
    setTags(item.tags);
    setPageCount(item.pageCount ?? 0);
    setRuntimeMetadata({});
    setPageIndex(0);
    setSeekAnchors([]);
    setRotation(0);
    setBookmarks([]);
    ascii2dGeneration.current += 1;
    setAscii2dStatus(undefined);
  }, [item?.id]);

  useEffect(() => {
    const dialogs = viewerBackdropRef.current?.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
    const dialog = dialogs?.item(dialogs.length - 1);
    if (dialog) return activateViewerDialog(dialog);
  }, [Boolean(item), showGifFrames, showTagEditor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (event.key === "Escape") {
        // A dropdown owns its first Escape; its document listener closes it.
        if (target?.closest('[role="listbox"], [role="menu"], [role="combobox"][aria-expanded="true"]')) return;
        if (imageContextMenu) return;
        event.preventDefault();
        if (isFullscreen) {
          event.preventDefault();
          void changeFullscreen(false).catch((caught: unknown) => setError(String(caught)));
        } else if (showGifFrames) closeGifFrames();
        else if (showTagEditor) setShowTagEditor(false);
        else if (showBookmarkList) setShowBookmarkList(false);
        else if (showBookSettings) setShowBookSettings(false);
        else if (infoLayout === "bottomSheet" && recommendSheetOpen) setRecommendSheetOpen(false);
        else onClose();
        return;
      }
      if (!item || showTagEditor || showGifFrames || showBookSettings || showBookmarkList) return;
      if (target?.closest('input, textarea, select, button, a[href], [contenteditable="true"], [role="listbox"], [role="combobox"], [role="menu"]')) return;
      const pageStep = bookViewMode === "spread" ? 2 : 1;
      if ((item.kind === "pdf" || item.kind === "archive") && ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
        event.preventDefault();
        setPageIndex((current) => bookSeekKeyPage(event.key, current, pageCount, bookBinding, pageStep) ?? current);
        return;
      }
      if (event.key === "ArrowLeft") {
        if (item.kind === "video") {
          event.preventDefault();
          videoRef.current && (videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - viewerControlPreferences.videoSeekSeconds));
        }
      }
      if (event.key === "ArrowRight") {
        if (item.kind === "video" && videoRef.current) {
          event.preventDefault();
          videoRef.current.currentTime = Math.min(videoRef.current.duration || Number.MAX_SAFE_INTEGER, videoRef.current.currentTime + viewerControlPreferences.videoSeekSeconds);
        }
      }
      if ((event.key === "r" || event.key === "R") && (item.kind === "image" || item.kind === "gif")) {
        event.preventDefault();
        setRotation((current) => (current + 90) % 360);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [bookBinding, bookViewMode, changeFullscreen, isFullscreen, closeGifFrames, imageContextMenu, infoLayout, item, onClose, pageCount, recommendSheetOpen, showBookmarkList, showBookSettings, showGifFrames, showTagEditor, viewerControlPreferences.videoSeekSeconds]);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(undefined), 3_500);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    if (!slideshow || !item || (item.kind !== "image" && item.kind !== "gif") || imageItems.length < 2) return;
    const timeout = window.setTimeout(() => {
      const currentIndex = imageItems.findIndex((candidate) => candidate.id === item.id);
      changeActive(imageItems[(currentIndex + 1 + imageItems.length) % imageItems.length].id);
      setSlideshow(true);
    }, SLIDESHOW_INTERVAL_MS);
    return () => window.clearTimeout(timeout);
  }, [changeActive, imageItems, item, slideshow]);

  useEffect(() => {
    if (!item || (item.kind !== "pdf" && item.kind !== "archive")) return;
    let active = true;
    void listBookBookmarks(item.id).then((result) => {
      if (active) setBookmarks(result.data.map((bookmark) => bookmark.pageIndex));
    });
    return () => { active = false; };
  }, [item]);

  const runAction = useCallback(async (key: string, action: () => Promise<string | void>) => {
    setBusyAction(key);
    setError(undefined);
    try {
      const nextMessage = await action();
      if (nextMessage) setMessage(nextMessage);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "操作に失敗しました。");
    } finally {
      setBusyAction(undefined);
    }
  }, []);

  const toggleFullscreen = () => {
    setError(undefined);
    void changeFullscreen().catch((fullscreenError: unknown) => {
      setError(fullscreenError instanceof Error ? fullscreenError.message : "全画面表示を開始できませんでした。");
    });
  };

  if (!item) {
    return (
      <div ref={viewerBackdropRef} className="pv-viewer-backdrop" role="presentation" onMouseDown={onClose}>
        <section ref={viewerShellRef} tabIndex={-1} className="pv-viewer-shell pv-viewer-missing" role="dialog" aria-modal="true" aria-label="メディアが見つかりません" onMouseDown={(event) => event.stopPropagation()}>
          <Unavailable icon="warning">選択したメディアが見つかりません。</Unavailable>
          <button type="button" className="pv-viewer-primary" onClick={onClose}>閉じる</button>
        </section>
      </div>
    );
  }

  const isBook = item.kind === "pdf" || item.kind === "archive";
  const isImage = item.kind === "image" || item.kind === "gif";
  const isCurrentPageBookmarked = bookmarks.includes(pageIndex);
  const bookPageStep = bookViewMode === "spread" ? 2 : 1;

  const currentImageBlob = async (): Promise<Blob> => {
    if (!imageRef.current) throw new Error("画像の表示完了後にもう一度お試しください。");
    const dataUrl = canvasDataUrl(imageRef.current, "image/png");
    const response = await fetch(dataUrl);
    return response.blob();
  };

  const copyCurrentImage = () => {
    setImageContextMenu(undefined);
    void runAction("copy-image", async () => {
      if (!("ClipboardItem" in window) || !navigator.clipboard?.write) {
        throw new Error("この環境では画像のクリップボードコピーを利用できません。");
      }
      const blob = await currentImageBlob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "画像をクリップボードへコピーしました。";
    });
  };

  const shareCurrentImage = () => {
    setImageContextMenu(undefined);
    void runAction("share-image", async () => {
      const blob = await currentImageBlob();
      const baseName = item.name.replace(/\.[^.]+$/, "") || "PixVault_Image";
      const file = new File([blob], `${baseName}.png`, { type: "image/png" });
      const shareData: ShareData = { title: item.name, files: [file] };
      if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
        await navigator.share(shareData);
        return "共有先へ画像を渡しました。";
      }
      if (!("ClipboardItem" in window) || !navigator.clipboard?.write) {
        throw new Error("この環境では共有機能を利用できません。");
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "共有機能がないため、画像をクリップボードへコピーしました。";
    });
  };

  const toggleFavorite = () => void runAction("favorite", async () => {
    const next = !favorite;
    const result = await setFavorite(item.id, next);
    const failure = resultError(result, "お気に入りはデスクトップアプリで変更できます。");
    if (failure) throw failure;
    setFavoriteState(next);
    patchViewerItem(item.id, { isFavorite: next });
    return next ? "お気に入りに追加しました。" : "お気に入りから外しました。";
  });

  const changeRating = (next: AgeRating) => void runAction("rating", async () => {
    const result = await setAgeRating(item.id, next);
    const failure = resultError(result, "年齢区分はデスクトップアプリで変更できます。");
    if (failure) throw failure;
    setAgeRatingState(result.data);
    patchViewerItem(item.id, { ageRating: result.data });
    return `年齢区分を${ratingLabel(result.data)}に変更しました。`;
  });

  const recycle = () => {
    if (!window.confirm(`「${item.name}」をWindowsのごみ箱へ移動しますか？`)) return;
    void runAction("recycle", async () => {
      let nextCollectionIndex: number | undefined;
      let nextItem: MediaItem | undefined;
      if (collection && activeCollectionIndex >= 0 && collectionTotalCount > 1) {
        nextCollectionIndex = activeCollectionIndex < collectionTotalCount - 1
          ? activeCollectionIndex + 1
          : activeCollectionIndex - 1;
        nextItem = await loadCollectionItem(nextCollectionIndex);
      } else {
        const currentIndex = items.findIndex((candidate) => candidate.id === item.id);
        nextItem = currentIndex >= 0
          ? items[currentIndex + 1] ?? items[currentIndex - 1]
          : viewerRailItems.find((candidate) => candidate.id !== item.id);
      }
      const result = await recycleMediaItem(item.id);
      const failure = resultError(result, "ごみ箱への移動はデスクトップアプリで利用できます。");
      if (failure || !result.data) throw failure ?? new Error("ごみ箱へ移動できませんでした。");
      if (nextItem) changeActive(nextItem.id, nextCollectionIndex);
      onRemove(item.id);
      if (!nextItem) onClose();
      return nextItem ? `「${nextItem.name}」を開きました。` : undefined;
    });
  };

  const capture = () => void runAction("capture", async () => {
    let dataUrl: string;
    if (item.kind === "video") {
      if (!videoRef.current) throw new Error("動画をまだ読み込んでいます。");
      dataUrl = canvasDataUrl(videoRef.current);
    } else if (isBook) {
      dataUrl = canvasesDataUrl(bookCanvasRefs.current.filter((canvas): canvas is HTMLCanvasElement => Boolean(canvas)));
    } else {
      if (!imageRef.current) throw new Error("画像をまだ読み込んでいます。");
      dataUrl = canvasDataUrl(imageRef.current);
    }
    const suffix = isBook
      ? bookViewMode === "spread" && pageIndex + 1 < pageCount
        ? `_p${pageIndex + 1}-${Math.min(pageCount, pageIndex + 2)}`
        : `_p${pageIndex + 1}`
      : "";
    const path = await persistCapture(dataUrl, `${fileStem(item.name)}${suffix}_${Date.now()}.png`);
    return `スクリーンショットを保存しました: ${path}`;
  });

  const rotateClockwise = () => {
    setRotation((current) => (current + 90) % 360);
    setMessage("表示を90°回転しました。元ファイルは変更されません。");
  };

  const toggleVideoPlayback = () => {
    const video = videoRef.current;
    if (!video) {
      setError("動画をまだ読み込んでいます。");
      return;
    }
    if (video.paused) {
      void video.play().catch((playError: unknown) => {
        setError(playError instanceof Error ? playError.message : "動画を再生できませんでした。");
      });
    } else {
      video.pause();
    }
  };

  const convertCurrentVideoToGif = () => void runAction("convert-gif", async () => {
    const result = await convertVideoToGif(item.id);
    const failure = resultError(result, "GIF変換はインストール版のWindowsアプリで利用できます。");
    if (failure) throw failure;
    if (!result.data) return "GIF変換をキャンセルしました。";
    return result.data.catalogued
      ? `GIFを保存し、ギャラリーへ追加しました: ${result.data.path}`
      : `GIFを保存しました（登録フォルダー外）: ${result.data.path}`;
  });

  const rememberSeekAnchor = (anchorPage: number) => {
    if (!seekAnchorsEnabled) return;
    const normalized = Math.max(0, Math.round(anchorPage));
    setSeekAnchors((current) => [
      normalized,
      ...current.filter((page) => page !== normalized),
    ].slice(0, maxSeekAnchors));
  };

  const startGifFrameExtraction = () => {
    const generation = gifDecodeGeneration.current + 1;
    gifDecodeGeneration.current = generation;
    setShowGifFrames(true);
    releaseGifFrames(gifFramesRef.current);
    gifFramesRef.current = [];
    setGifFrames([]);
    setGifFrameError(undefined);
    if (item.kind !== "gif" || !source) {
      setGifFrameError("GIFファイルを開けません。");
      return;
    }
    const ImageDecoder = (window as unknown as { ImageDecoder?: GifImageDecoderConstructor }).ImageDecoder;
    if (!ImageDecoder) {
      setGifFrameError("この環境はGIFのフレーム展開に対応していません。最新版のWindows WebView2で開いてください。");
      return;
    }
    void runAction("gif-frames", async () => {
      try {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`GIFファイルを読み込めませんでした（${response.status}）。`);
        const decoder = new ImageDecoder({
          data: await response.arrayBuffer(),
          type: item.mimeType === "image/gif" ? item.mimeType : "image/gif",
          preferAnimation: true,
        });
        try {
          await decoder.tracks.ready;
          if (gifDecodeGeneration.current !== generation) return;
          const availableFrames = decoder.tracks.selectedTrack?.frameCount ?? 0;
          if (availableFrames <= 0) throw new Error("GIFに表示できるコマがありません。");
          const total = Math.min(availableFrames, MAX_GIF_FRAME_COUNT);
          setGifFrameProgress({ current: 0, total });
          const decoded: GifFrame[] = [];
          let decodedPixels = 0;
          let limitMessage: string | undefined;
          for (let frameIndex = 0; frameIndex < total; frameIndex += 1) {
            if (gifDecodeGeneration.current !== generation) return;
            const result = await decoder.decode({ frameIndex, completeFramesOnly: true });
            const frame = result.image;
            if (gifDecodeGeneration.current !== generation) {
              frame.close?.();
              return;
            }
            const naturalWidth = frame.displayWidth || frame.codedWidth || 1;
            const naturalHeight = frame.displayHeight || frame.codedHeight || 1;
            const scale = Math.min(1, 420 / Math.max(naturalWidth, naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(naturalHeight * scale));
            const framePixels = canvas.width * canvas.height;
            if (decoded.length > 0 && decodedPixels + framePixels > MAX_GIF_FRAME_PIXELS) {
              frame.close?.();
              limitMessage = `メモリ保護のため${decoded.length}コマで停止しました（展開画像は合計2,000万画素まで）。`;
              break;
            }
            const context = canvas.getContext("2d");
            if (!context) {
              frame.close?.();
              throw new Error("GIFフレーム用の描画領域を作成できません。");
            }
            context.drawImage(frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob>((resolve, reject) => {
              canvas.toBlob((result) => result ? resolve(result) : reject(new Error("GIFフレームをPNGへ変換できませんでした。")), "image/png");
            });
            if (gifDecodeGeneration.current !== generation) {
              frame.close?.();
              return;
            }
            decoded.push({
              dataUrl: URL.createObjectURL(blob),
              durationMs: Math.max(0, Number(frame.duration ?? 0) / 1_000),
            });
            gifFramesRef.current = decoded;
            decodedPixels += framePixels;
            frame.close?.();
            if (frameIndex % 4 === 3 || frameIndex === total - 1) {
              const nextFrames = [...decoded];
              gifFramesRef.current = nextFrames;
              setGifFrames(nextFrames);
              setGifFrameProgress({ current: frameIndex + 1, total });
              await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            }
          }
          const nextFrames = [...decoded];
          gifFramesRef.current = nextFrames;
          setGifFrames(nextFrames);
          setGifFrameProgress(undefined);
          if (limitMessage) {
            setGifFrameError(limitMessage);
          } else if (availableFrames > total) {
            setGifFrameError(`メモリ保護のため先頭${total}コマまで表示しています（全${availableFrames}コマ）。`);
          }
          return `${decoded.length}コマを展開しました。`;
        } finally {
          decoder.close();
        }
      } catch (frameError) {
        const failure = frameError instanceof Error ? frameError.message : "GIFのコマを展開できませんでした。";
        setGifFrameProgress(undefined);
        setGifFrameError(failure);
        throw frameError;
      }
    });
  };

  const extractGifFrames = () => {
    const openFramePopup = () => {
      startGifFrameExtraction();
    };
    if (isFullscreen) {
      void changeFullscreen(false)
        .then(openFramePopup)
        .catch((fullscreenError: unknown) => {
          setError(fullscreenError instanceof Error
            ? fullscreenError.message
            : "全画面表示を終了できませんでした。");
        });
      return;
    }
    openFramePopup();
  };

  const setAsWallpaper = () => void runAction("wallpaper", async () => {
    const result = await setWallpaper(item.id);
    const failure = resultError(result, "壁紙設定はWindows版アプリで利用できます。");
    if (failure || !result.data) throw failure ?? new Error("壁紙を設定できませんでした。");
    return "デスクトップの壁紙に設定しました。";
  });

  const revealCurrentFile = () => void runAction("reveal", async () => {
    const result = await revealMediaInExplorer(item.id);
    const failure = resultError(result, "エクスプローラーで現在のファイルを表示できませんでした。");
    if (failure || !result.data) throw failure ?? new Error("エクスプローラーを開けませんでした。");
    return "エクスプローラーで現在のファイルを表示しました。";
  });

  const searchAscii2d = () => {
    if (ascii2dStatus) return;
    const generation = ascii2dGeneration.current + 1;
    ascii2dGeneration.current = generation;
    setError(undefined);
    setMessage(undefined);
    setAscii2dStatus("画像を検索用に準備しています…");
    void (async () => {
      try {
        const result = await requestAscii2dSearch(item.id);
        if (ascii2dGeneration.current !== generation) return;
        if (!result.available) {
          throw new Error("ascii2d画像検索はインストール版のWindowsアプリで利用できます。");
        }
        if (result.error) throw new Error(result.error);
        if (!result.data) throw new Error("ascii2dから検索結果URLを取得できませんでした。");
        setAscii2dStatus("検索結果を開いています…");
        await openUrl(result.data);
        if (ascii2dGeneration.current !== generation) return;
        setMessage("ascii2dへ画像を送信し、検索結果を開きました。");
      } catch (ascii2dError) {
        if (ascii2dGeneration.current !== generation) return;
        setError(ascii2dError instanceof Error
          ? ascii2dError.message
          : "ascii2d画像検索を完了できませんでした。");
      } finally {
        if (ascii2dGeneration.current === generation) setAscii2dStatus(undefined);
      }
    })();
  };

  const toggleBookmark = () => void runAction("bookmark", async () => {
    const next = !isCurrentPageBookmarked;
    const result = await setBookBookmark(item.id, pageIndex, next);
    const failure = resultError(result, "しおりはWindows版アプリで利用できます。");
    if (failure || !result.data) throw failure ?? new Error("しおりを変更できませんでした。");
    setBookmarks((current) => next
      ? [...new Set([...current, pageIndex])].sort((left, right) => left - right)
      : current.filter((page) => page !== pageIndex));
    return next ? `${pageIndex + 1}ページにしおりを追加しました。` : "しおりを外しました。";
  });

  const removeBookmark = (bookmarkPage: number) => void runAction(`bookmark-${bookmarkPage}`, async () => {
    const result = await setBookBookmark(item.id, bookmarkPage, false);
    const failure = resultError(result, "しおりはWindows版アプリで利用できます。");
    if (failure || !result.data) throw failure ?? new Error("しおりを削除できませんでした。");
    setBookmarks((current) => current.filter((page) => page !== bookmarkPage));
    return `${bookmarkPage + 1}ページのしおりを削除しました。`;
  });

  const changeBookViewMode = (next: BookViewMode) => {
    setBookViewMode(next);
    if (next === "spread") setPageIndex((current) => Math.floor(current / 2) * 2);
    void saveBookViewerSettings({ viewMode: next }).then((failure) => {
      if (failure) setError(failure);
    });
  };

  const changeBookBinding = (next: BookBinding) => {
    setBookBinding(next);
    void saveBookViewerSettings({ binding: next }).then((failure) => {
      if (failure) setError(failure);
    });
  };

  const availableViewerActions: ViewerActionId[] = isImage
    ? [
        "favorite", "tags", "capture", "reveal", "rotate",
        ...(item.kind === "gif" ? ["gifFrames" as const] : []),
        "ascii2d", "wallpaper", "slideshow", "recycle",
      ]
    : item.kind === "video"
      ? ["favorite", "tags", "playPause", "convertGif", "capture", "reveal", "recycle"]
      : isBook
        ? ["favorite", "tags", "bookmark", "bookmarkList", "bookSettings", "capture", "reveal", "recycle"]
        : ["favorite", "tags", "reveal", "recycle"];
  const preferredViewerActions = isImage
    ? viewerControlPreferences.imageActions
    : item.kind === "video"
      ? viewerControlPreferences.videoActions
      : isBook
        ? viewerControlPreferences.bookActions
        : [];
  const orderedViewerActions = [
    ...preferredViewerActions.filter((action) => availableViewerActions.includes(action)),
    ...availableViewerActions,
  ].filter((action, index, values) => values.indexOf(action) === index);

  const renderViewerAction = (action: ViewerActionId): ReactNode => {
    switch (action) {
      case "favorite":
        return <ActionButton key={action} icon="heart" label={favorite ? "お気に入り済み" : "お気に入り"} active={favorite} disabled={busyAction === "favorite"} onClick={toggleFavorite} />;
      case "tags":
        return <ActionButton key={action} icon="tag" label="タグ" onClick={() => setShowTagEditor(true)} />;
      case "capture":
        return <ActionButton key={action} icon="camera" label="スクリーンショット" disabled={busyAction === "capture"} onClick={capture} />;
      case "reveal":
        return <ActionButton key={action} icon="folder" label="エクスプローラーで表示" disabled={busyAction === "reveal"} onClick={revealCurrentFile} />;
      case "recycle":
        return <ActionButton key={action} icon="trash" label="ごみ箱" danger disabled={busyAction === "recycle"} onClick={recycle} />;
      case "rotate":
        return <ActionButton key={action} icon="refresh" label={`90°回転（現在 ${rotation}°）`} active={rotation !== 0} onClick={rotateClockwise} />;
      case "ascii2d":
        return <ActionButton key={action} icon="search" label={ascii2dStatus ? "ascii2d検索中…" : "ascii2d"} busy={Boolean(ascii2dStatus)} disabled={Boolean(ascii2dStatus)} onClick={searchAscii2d} />;
      case "wallpaper":
        return <ActionButton key={action} icon="wallpaper" label="壁紙" disabled={busyAction === "wallpaper"} onClick={setAsWallpaper} />;
      case "slideshow":
        return <ActionButton key={action} icon={slideshow ? "pause" : "play"} label={slideshow ? "スライドショー停止" : "スライドショー"} active={slideshow} disabled={imageItems.length < 2} onClick={() => setSlideshow((current) => !current)} />;
      case "gifFrames":
        return <ActionButton key={action} icon="grid" label="コマ画像へ展開" disabled={busyAction === "gif-frames"} onClick={extractGifFrames} />;
      case "playPause":
        return <ActionButton key={action} icon="play" label="再生・一時停止" onClick={toggleVideoPlayback} />;
      case "convertGif":
        return <ActionButton key={action} icon="grid" label="GIF変換" busy={busyAction === "convert-gif"} disabled={busyAction === "convert-gif"} onClick={convertCurrentVideoToGif} />;
      case "bookmark":
        return <ActionButton key={action} icon="bookmark" label={isCurrentPageBookmarked ? "しおり済み" : "しおり"} active={isCurrentPageBookmarked} disabled={busyAction === "bookmark"} onClick={toggleBookmark} />;
      case "bookmarkList":
        return <ActionButton key={action} icon="list" label={`しおり一覧${bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}`} active={showBookmarkList} onClick={() => { setShowBookmarkList((current) => !current); setShowBookSettings(false); }} />;
      case "bookSettings":
        return <ActionButton key={action} icon="settings" label="表示設定" active={showBookSettings} onClick={() => { setShowBookSettings((current) => !current); setShowBookmarkList(false); }} />;
      default:
        return null;
    }
  };

  const viewerContent = (() => {
    if (isImage) {
      return (
        <ImageViewer
          item={item}
          source={source}
          imageRef={imageRef}
          rotation={rotation}
          doubleClickZoom={viewerControlPreferences.doubleClickZoom}
          shortcutsEnabled={!showTagEditor && !showGifFrames}
          onLoadingChange={handleMediaLoading}
          onError={setError}
          onMetadata={updateRuntimeMetadata}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setImageContextMenu({
              x: Math.min(event.clientX, window.innerWidth - 190),
              y: Math.min(event.clientY, window.innerHeight - 118),
            });
          }}
        />
      );
    }
    if (item.kind === "video") {
      return (
        <VideoViewer
          item={item}
          source={source}
          videoRef={videoRef}
          playbackPreferences={videoPlaybackPreferences}
          seekSeconds={viewerControlPreferences.videoSeekSeconds}
          onPlaybackPreferencesChange={rememberVideoPlaybackPreferences}
          onError={setError}
          onLoadingChange={handleMediaLoading}
          menusHidden={menusHidden}
          onMetadata={updateRuntimeMetadata}
        />
      );
    }
    if (isBook) {
      return (
        <BookViewer
          key={item.id}
          item={item}
          pageIndex={pageIndex}
          onPageIndexChange={setPageIndex}
          canvasRefs={bookCanvasRefs}
          onPageCountChange={setPageCount}
          onLoadingChange={handleMediaLoading}
          onError={setError}
          viewMode={bookViewMode}
          binding={bookBinding}
          menusHidden={menusHidden}
          seekAnchors={seekAnchorsEnabled ? seekAnchors : []}
          onSeekStart={rememberSeekAnchor}
        />
      );
    }
    return <Unavailable icon="file">この形式のビュワーはまだありません。</Unavailable>;
  })();

  return (
    <div ref={viewerBackdropRef} className="pv-viewer-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={viewerShellRef}
        className={`pv-viewer-shell rating-${ageRating.toLowerCase()}${isFullscreen ? " is-fullscreen" : ""}${menusHidden ? " menus-hidden" : ""}`}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={menusHidden ? undefined : "pv-viewer-title"}
        aria-label={menusHidden ? item.name : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {menusHidden && (
          <button
            type="button"
            className="pv-viewer-menu-restore"
            aria-label="全画面表示を終了（Esc）"
            title="全画面表示を終了（Esc）"
            onClick={toggleFullscreen}
          >
            <Icon name="fullscreenExit" />
          </button>
        )}
        {isImage && imageContextMenu && (
          <div
            className="pv-image-context-menu"
            role="menu"
            aria-label="画像の操作"
            style={{ left: imageContextMenu.x, top: imageContextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={copyCurrentImage}>
              <Icon name="copy" /><span><strong>画像をコピー</strong><small>PNGとしてクリップボードへ</small></span>
            </button>
            <button type="button" role="menuitem" onClick={shareCurrentImage}>
              <Icon name="share" /><span><strong>共有</strong><small>Windowsの共有先を選択</small></span>
            </button>
          </div>
        )}
        {!menusHidden && <header className="pv-viewer-header">
          <div className="pv-viewer-title">
            <div className="pv-viewer-title-eyebrow">
              <span className="pv-viewer-kicker">{mediaKindLabel(item)}</span>
              <span className="pv-viewer-rating-accent">
                <i />
                {ratingLabel(ageRating)}
              </span>
            </div>
            <h2 id="pv-viewer-title">{item.name}</h2>
            <p title={item.path}>{item.path}</p>
          </div>
          <div className="pv-viewer-header-meta">
            <div className="pv-rating-switch" aria-label="年齢区分">
              {(["UNRATED", "SFW", "R15", "R18"] as const).map((rating) => (
                <button
                  key={rating}
                  type="button"
                  className={ageRating === rating ? `is-active rating-${rating.toLowerCase()}` : ""}
                  aria-pressed={ageRating === rating}
                  disabled={busyAction === "rating"}
                  onClick={() => changeRating(rating)}
                >
                  {ratingLabel(rating)}
                </button>
              ))}
            </div>
            {(isImage || item.kind === "video" || isBook) && (
              <IconControl
                icon={isFullscreen ? "fullscreenExit" : "fullscreen"}
                label={isFullscreen ? "全画面表示を終了（Esc）" : "全画面表示"}
                onClick={toggleFullscreen}
              />
            )}
            <IconControl icon="close" label="閉じる" onClick={onClose} />
          </div>
        </header>}

        <div className={`pv-viewer-content-grid info-${infoLayout}${recommendSheetOpen ? "" : " info-panel-collapsed"}`}>
          <main className="pv-viewer-main">
            {viewerContent}
            {isBook && showBookSettings && (
            <aside className="pv-book-side-panel pv-book-settings-panel" role="dialog" aria-label="ブック表示設定">
              <header>
                <div>
                  <span className="pv-viewer-kicker">BOOK VIEW</span>
                  <h3>表示設定</h3>
                </div>
                <IconControl icon="close" label="表示設定を閉じる" onClick={() => setShowBookSettings(false)} />
              </header>
              <fieldset>
                <legend>ページ表示</legend>
                <div className="pv-book-setting-options">
                  <button type="button" className={bookViewMode === "spread" ? "is-active" : ""} aria-pressed={bookViewMode === "spread"} onClick={() => changeBookViewMode("spread")}>
                    <Icon name="book" /><span><b>見開き</b><small>2ページを並べる</small></span>
                  </button>
                  <button type="button" className={bookViewMode === "single" ? "is-active" : ""} aria-pressed={bookViewMode === "single"} onClick={() => changeBookViewMode("single")}>
                    <Icon name="file" /><span><b>単ページ</b><small>1ページずつ表示</small></span>
                  </button>
                </div>
              </fieldset>
              <fieldset>
                <legend>綴じ方向</legend>
                <div className="pv-book-setting-options">
                  <button type="button" className={bookBinding === "left" ? "is-active" : ""} aria-pressed={bookBinding === "left"} onClick={() => changeBookBinding("left")}>
                    <Icon name="arrowRight" /><span><b>左綴じ</b><small>左から右へ読む</small></span>
                  </button>
                  <button type="button" className={bookBinding === "right" ? "is-active" : ""} aria-pressed={bookBinding === "right"} onClick={() => changeBookBinding("right")}>
                    <Icon name="arrowRight" className="pv-icon-reverse" /><span><b>右綴じ</b><small>右から左へ読む（既定）</small></span>
                  </button>
                </div>
              </fieldset>
            </aside>
            )}
            {isBook && showBookmarkList && (
            <aside className="pv-book-side-panel pv-bookmark-panel" role="dialog" aria-label="しおり一覧">
              <header>
                <div>
                  <span className="pv-viewer-kicker">BOOKMARKS</span>
                  <h3>しおり一覧</h3>
                </div>
                <IconControl icon="close" label="しおり一覧を閉じる" onClick={() => setShowBookmarkList(false)} />
              </header>
              <div className="pv-bookmark-list">
                {bookmarks.length === 0
                  ? <div className="pv-bookmark-empty"><Icon name="bookmark" /><b>しおりはまだありません</b><span>下の「しおり」から表示中のページを登録できます。</span></div>
                  : bookmarks.map((bookmarkPage) => (
                    <div key={bookmarkPage} className={bookmarkPage === pageIndex ? "is-current" : ""}>
                      <button
                        type="button"
                        onClick={() => {
                          setPageIndex(bookViewMode === "spread" ? Math.floor(bookmarkPage / 2) * 2 : bookmarkPage);
                          setShowBookmarkList(false);
                        }}
                      >
                        <Icon name="bookmark" />
                        <span><b>{bookmarkPage + 1}ページ</b><small>クリックして移動</small></span>
                        <Icon name="arrowRight" />
                      </button>
                      <button
                        type="button"
                        className="pv-bookmark-remove"
                        aria-label={`${bookmarkPage + 1}ページのしおりを削除`}
                        title="しおりを削除"
                        disabled={busyAction === `bookmark-${bookmarkPage}`}
                        onClick={() => removeBookmark(bookmarkPage)}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  ))}
              </div>
            </aside>
            )}
            {loading && <div className="pv-viewer-page-loading" role="status"><span /><b>{isBook ? "ページを描画中…" : "メディアを読み込み中…"}</b></div>}
            {ascii2dStatus && (
              <div className="pv-ascii2d-progress" role="status" aria-live="polite">
                <i />
                <div>
                  <strong>ascii2d画像検索</strong>
                  <span>{ascii2dStatus}</span>
                </div>
              </div>
            )}
            {message && <div className="pv-viewer-toast" role="status">{message}</div>}
            {error && <div className="pv-viewer-toast is-error" role="alert">{error}<button type="button" onClick={() => setError(undefined)}><Icon name="close" /></button></div>}
          </main>
          {!menusHidden && surroundingsReady && (
            <MediaInfoSidebar
              item={item}
              items={availableItems}
              tags={tags}
              ageRating={ageRating}
              favorite={favorite}
              runtimeMetadata={runtimeMetadata}
              pageCount={pageCount}
              pageIndex={pageIndex}
              layout={infoLayout}
              open={recommendSheetOpen}
              busy={busyAction === "reveal"}
              onToggleOpen={() => setRecommendSheetOpen((current) => !current)}
              onLayoutChange={moveInfoLayout}
              onSelect={selectRecommendation}
              onEditTags={() => setShowTagEditor(true)}
              onReveal={revealCurrentFile}
            />
          )}
        </div>

        {!menusHidden && surroundingsReady && viewerRailItemCount > 0 && (
          <MediaThumbnailRail
            itemCount={viewerRailItemCount}
            currentIndex={viewerRailCurrentIndex}
            itemAt={viewerRailItemAt}
            open={viewerRailOpen}
            onSelect={selectViewerRailItem}
            onToggle={() => setViewerRailOpen((current) => !current)}
            onVisibleRangeChange={viewerRailIncludesAllMedia ? ensureCollectionRange : undefined}
            includesAllMedia={viewerRailIncludesAllMedia}
          />
        )}

        {!menusHidden && isBook && (
          <div className="pv-book-controls">
            <button
              type="button"
              onClick={() => currentBookIndex > 0 && changeActive(bookItems[currentBookIndex - 1].id)}
              disabled={currentBookIndex <= 0}
            >
              <Icon name="stepBack" />前の本
            </button>
            <button type="button" onClick={() => setPageIndex((current) => Math.max(0, current - bookPageStep))} disabled={pageIndex <= 0}>
              <Icon name="arrowRight" className="pv-icon-reverse" />前のページ
            </button>
            <span>
              {pageCount > 0
                ? bookViewMode === "spread"
                  ? `${Math.floor(pageIndex / 2) * 2 + 1}–${Math.min(pageCount, Math.floor(pageIndex / 2) * 2 + 2)} / ${pageCount}`
                  : `${pageIndex + 1} / ${pageCount}`
                : "— / —"}
            </span>
            <button type="button" onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + bookPageStep))} disabled={pageCount <= 0 || pageIndex + bookPageStep >= pageCount}>
              次のページ<Icon name="arrowRight" />
            </button>
            <button
              type="button"
              onClick={() => currentBookIndex >= 0 && currentBookIndex < bookItems.length - 1 && changeActive(bookItems[currentBookIndex + 1].id)}
              disabled={currentBookIndex < 0 || currentBookIndex >= bookItems.length - 1}
            >
              次の本<Icon name="stepForward" />
            </button>
          </div>
        )}

        {!menusHidden && <footer className="pv-viewer-footer">
          <div className="pv-viewer-actions">
            {orderedViewerActions.map(renderViewerAction)}
          </div>
          <div className="pv-viewer-tag-summary">
            <strong>{ratingLabel(ageRating)}</strong>
            {tags.length > 0
              ? tags.slice(0, 5).map((tag) => {
                const translatedName = translateTag(tag.name);
                return <span key={tag.id} title={translatedName !== tag.name ? tag.name : undefined}>{translatedName}</span>;
              })
              : <span>タグなし</span>}
          </div>
        </footer>}
      </section>
      {showTagEditor && (
        <TagEditor
          item={{ ...item, tags }}
          onClose={() => setShowTagEditor(false)}
          onSaved={(nextTags) => {
            setTags(nextTags);
            patchViewerItem(item.id, { tags: nextTags });
            setMessage("タグを保存しました。");
          }}
        />
      )}
      {showGifFrames && item.kind === "gif" && (
        <GifFramesModal
          item={item}
          frames={gifFrames}
          progress={gifFrameProgress}
          error={gifFrameError}
          onClose={closeGifFrames}
        />
      )}
    </div>
  );
}

function ratingLabel(rating: AgeRating): string {
  switch (rating) {
    case "UNRATED": return "未選択";
    case "R15": return "R-15";
    case "R18": return "R-18";
    default: return "健全";
  }
}

function mediaKindLabel(item: MediaItem): string {
  switch (item.kind) {
    case "image": return "IMAGE VIEWER";
    case "gif": return "GIF VIEWER";
    case "video": return "VIDEO VIEWER";
    case "pdf": return "PDF BOOK";
    case "archive": return "ZIP BOOK";
    default: return "MEDIA VIEWER";
  }
}
