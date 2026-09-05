import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "../appVersion";

export type MediaKind =
  | "image"
  | "gif"
  | "video"
  | "pdf"
  | "archive"
  | "document"
  | "unknown";

export type AgeRating = "UNRATED" | "SFW" | "R15" | "R18";
export type ViewerInfoLayout = "sidebar" | "bottomSheet";

export type RuntimeInfo = {
  appName: string;
  appVersion: string;
  os: string;
  arch: string;
  databaseSchemaVersion: number;
  migrationFormatVersion: number;
  automaticUpdatesEnabled: boolean;
  updateHttpsEndpointConfigured: boolean;
  updatePublicKeyConfigured: boolean;
  windowsSigningCertificateConfigured: boolean;
};

export type SystemDiagnostics = {
  checkedAt: number;
  status: "healthy" | "issues";
  quickCheckMessages: string[];
  foreignKeyIssues: number;
  databaseSchemaVersion: number;
  databaseBytes: number;
  walBytes: number;
  rootCount: number;
  mediaCount: number;
  missingMediaCount: number;
  lastCrashDetected: boolean;
  lastCrashSummary?: string;
};

export type DiagnosticExportResult = {
  path: string;
  bytes: number;
};

export type RecoverySnapshotResult = DiagnosticExportResult & {
  sha256: string;
};

export type LibraryRoot = {
  id: string;
  path: string;
  displayName: string;
  createdAt?: string;
  lastScannedAt?: string;
  mediaCount: number;
  isPriority: boolean;
};

export type FileSystemListing = {
  path: string | null;
  parentPath: string | null;
  folders: Array<{ path: string; displayName: string }>;
  rootId: string | null;
  relativeFolder: string;
  priorityPath: string | null;
};

export async function browseFileSystem(path?: string, scan = true): Promise<NativeResult<FileSystemListing | null>> {
  const result = await call<FileSystemListing | null>("browse_file_system", { path, scan }, null);
  if (result.data && scan) clearCatalogCaches();
  return result;
}

export async function setFolderPriority(rootId: string, priority: boolean): Promise<NativeResult<boolean>> {
  const result = await call("set_folder_priority", { rootId, priority }, null);
  if (!result.error) clearCatalogCaches();
  return { ...result, data: result.available && !result.error };
}

export async function syncMediaFolder(rootId: string, folderPath?: string): Promise<NativeResult<boolean>> {
  const result = await call("sync_media_folder", { rootId, folderPath }, null);
  if (!result.error) clearCatalogCaches();
  return { ...result, data: result.available && !result.error };
}

export type MediaFolder = {
  rootId: string;
  relativeFolder: string;
  displayName: string;
  itemCount: number;
};

export type FolderGroupMember = {
  rootId: string;
  relativeFolder: string;
  displayName: string;
  rootName: string;
  sortOrder: number;
};

export type FolderGroup = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  members: FolderGroupMember[];
};

export type FolderGroupMemberInput = Pick<FolderGroupMember, "rootId" | "relativeFolder">;

export type LibrarySummary = {
  totalItems: number;
  images: number;
  gifs: number;
  videos: number;
  books: number;
  documents: number;
  favorites: number;
  tags: number;
  libraryRoots: number;
  storageBytes: number;
  lastScannedAt?: string;
};

export type MediaItem = {
  id: string;
  rootId?: string;
  relativePath?: string;
  path: string;
  name: string;
  kind: MediaKind;
  mimeType?: string;
  thumbnailPath?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  sizeBytes: number;
  modifiedAt?: string;
  importedAt?: string;
  isFavorite: boolean;
  ageRating: AgeRating;
  tags: Tag[];
  pageCount?: number;
};

export type ExternalMediaOpenBatch = {
  requestId: string;
  items: MediaItem[];
  currentId: string;
};

export type Tag = {
  id: string;
  name: string;
  color?: string;
  source?: "ai" | "user" | string;
  /** AI confidence normalized to the 0..1 range. */
  confidence?: number;
  aiCategory?: string;
};

export type MediaQuery = {
  kind?: MediaKind | MediaKind[];
  favoritesOnly?: boolean;
  /** Restrict to priority folders and catalog roots beneath them. */
  priorityOnly?: boolean;
  search?: string;
  rootId?: string;
  /** Undefined includes a whole root; an empty string means the root itself. */
  folderPath?: string;
  ageRating?: AgeRating;
  tagIds?: string[];
  modifiedFrom?: number;
  modifiedBefore?: number;
  sortBy?: "name" | "modifiedAt" | "size" | "importedAt";
  sortDirection?: "asc" | "desc";
  includeDateGroups?: boolean;
  limit?: number;
  offset?: number;
};

export type MediaDateGroup = {
  date: string;
  itemCount: number;
};

export type MediaPageInfo = {
  totalCount: number;
  dateGroups: MediaDateGroup[];
};

export type VisualMediaRecommendation = {
  item: MediaItem;
  similarity: number;
};

export type VisualRecommendationResult = {
  recommendations: VisualMediaRecommendation[];
  indexedCount: number;
  candidateCount: number;
  pending: boolean;
};

export type AdjacentSimilarGroup = {
  id: string;
  mediaIds: string[];
  representative: MediaItem;
  minimumSimilarity: number;
};

export type AdjacentSimilarityResult = {
  groups: AdjacentSimilarGroup[];
  indexedCount: number;
  candidateCount: number;
  pending: boolean;
};

export type BookBookmark = {
  id: string;
  mediaId: string;
  pageIndex: number;
  label?: string;
  createdAt: string;
};

export type TemporaryReferenceCacheResult = {
  path: string;
  bytes: number;
};

export type TemporaryReferenceCleanupResult = {
  removed: number;
  missing: number;
};

export type VideoGifConversionResult = {
  path: string;
  catalogued: boolean;
};

export type ArchiveBookInfo = {
  pageCount: number;
  pageNames: string[];
};

export type ArchiveBookPageCacheEntry = {
  pageIndex: number;
  path?: string;
  error?: string;
};

export type UserPreferences = {
  theme: "dark" | "light" | "system";
  themePalette: string;
  themeBackground: string;
  themeSurface: string;
  themeText: string;
  themeMuted: string;
  themeAccent: string;
  themeDanger: string;
  themeSuccess: string;
  themeBorder: string;
  nativeNotifications: boolean;
  thumbnailSize: "small" | "medium" | "large";
  defaultSort: "name" | "modifiedAt" | "importedAt";
  viewerInfoLayout: ViewerInfoLayout;
  confirmBeforeRecycle: boolean;
  watchFolders: boolean;
  autoAnalyze: boolean;
  [key: string]: string | number | boolean;
};

export type XHistoryItem = {
  id: string;
  url: string;
  title?: string;
  author?: string;
  previewUrl?: string;
  status: "queued" | "saved" | "failed";
  savedPath?: string;
  createdAt: string;
  error?: string;
};

export type XMediaKind = "image" | "gif" | "video";

export type XMediaVariant = {
  id: string;
  label: string;
  url: string;
  extension: string;
  width?: number;
  height?: number;
  bitrate?: number;
};

export type XMediaChoice = {
  id: string;
  kind: XMediaKind;
  previewUrl: string;
  width?: number;
  height?: number;
  variants: XMediaVariant[];
  alreadyDownloaded: boolean;
  existingPath?: string;
};

export type XPostInspection = {
  sourceUrl: string;
  postId: string;
  author: string;
  postText: string;
  media: XMediaChoice[];
};

export type XMediaSelection = {
  mediaId: string;
  variantId: string;
};

export type XDownloadResult = {
  history: XHistoryItem;
  files: string[];
  mediaCount: number;
  media: XDownloadedMedia[];
  duplicateCount: number;
  duplicatePaths: string[];
};

export type XDownloadedMedia = {
  mediaId: string;
  kind: XMediaKind;
  path: string;
  finalPath?: string;
  gifFinalizeToken?: string;
};

export type XGifFinalizeResult = {
  path: string;
  history?: XHistoryItem;
  removedSource: boolean;
};

export type ImportCatalogResult = {
  importedFavorites: number;
  importedTags: number;
  importedSettings: number;
  importedXHistory: number;
  unmatchedMedia: number;
};

export type MigrationIssue = {
  severity: "warning" | "error";
  entityType: string;
  sourceIdentity: string;
  message: string;
};

export type MigrationArchivePreview = {
  token: string;
  sourceName: string;
  sourceSha256: string;
  androidVersion: string;
  exportedAt: string;
  totalMedia: number;
  matchedMedia: number;
  ambiguousMedia: number;
  missingMedia: number;
  matchedBookmarks: number;
  unmatchedBookmarks: number;
  tagRecords: number;
  bookmarkRecords: number;
  referenceRecords: number;
  xHistoryRecords: number;
  settingsNamespaces: number;
  issueCount: number;
  alreadyImported: boolean;
  issues: MigrationIssue[];
  unresolvedMedia: MigrationUnresolvedMedia[];
};

export type MigrationResolutionCandidate = {
  mediaId: string;
  fileName: string;
  relativePath: string;
  fileSize: number;
  modifiedAt: number;
};

export type MigrationUnresolvedMedia = {
  sourceIdentity: string;
  fileName: string;
  relativePath?: string;
  fileSize: number;
  status: "ambiguous" | "missing";
  candidates: MigrationResolutionCandidate[];
};

export type MigrationImportResult = {
  sourceName: string;
  sourceSha256: string;
  alreadyImported: boolean;
  importedMedia: number;
  importedFavorites: number;
  importedTags: number;
  importedBookmarks: number;
  importedReferenceProjects: number;
  importedReferenceItems: number;
  importedXHistory: number;
  importedSettingsNamespaces: number;
  skippedMedia: number;
  issueCount: number;
};

export type SettingsBackupResult = {
  path: string;
  preferences: number;
};

export type NativeResult<T> = {
  data: T;
  available: boolean;
  error?: string;
};

export type MediaThumbnailLookup = {
  mediaId: string;
  thumbnailPath: string | null;
};

export type InAppBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InAppBrowserAction = "back" | "forward" | "reload";

const emptyRuntimeInfo: RuntimeInfo = {
  appName: "PixVault for Windows",
  appVersion: APP_VERSION,
  os: "browser preview",
  arch: "web",
  databaseSchemaVersion: 8,
  migrationFormatVersion: 1,
  automaticUpdatesEnabled: false,
  updateHttpsEndpointConfigured: false,
  updatePublicKeyConfigured: false,
  windowsSigningCertificateConfigured: false,
};

const emptySystemDiagnostics: SystemDiagnostics = {
  checkedAt: 0,
  status: "healthy",
  quickCheckMessages: [],
  foreignKeyIssues: 0,
  databaseSchemaVersion: 8,
  databaseBytes: 0,
  walBytes: 0,
  rootCount: 0,
  mediaCount: 0,
  missingMediaCount: 0,
  lastCrashDetected: false,
};

export const emptyLibrarySummary: LibrarySummary = {
  totalItems: 0,
  images: 0,
  gifs: 0,
  videos: 0,
  books: 0,
  documents: 0,
  favorites: 0,
  tags: 0,
  libraryRoots: 0,
  storageBytes: 0,
};

export const defaultPreferences: UserPreferences = {
  theme: "dark",
  themePalette: "default",
  themeBackground: "#0c0912",
  themeSurface: "#121019",
  themeText: "#f7f4ff",
  themeMuted: "#a7a1b2",
  themeAccent: "#a77bf3",
  themeDanger: "#ff7189",
  themeSuccess: "#67dda8",
  themeBorder: "#30283a",
  nativeNotifications: true,
  thumbnailSize: "medium",
  defaultSort: "modifiedAt",
  viewerInfoLayout: "sidebar",
  confirmBeforeRecycle: true,
  watchFolders: true,
  autoAnalyze: false,
};

const MEDIA_INFO_CACHE_TTL_MS = 60_000;
const LIBRARY_OVERVIEW_CACHE_TTL_MS = 1_500;
const MEDIA_PAGE_CACHE_LIMIT = 36;
const MEDIA_INFO_CACHE_LIMIT = 64;
// A library commonly contains tens of thousands of items. Thumbnail paths are
// short strings, so retaining a full medium-size catalog costs only a few MB
// and avoids repeating one IPC/SQLite lookup per card on revisit.
const THUMBNAIL_PATH_CACHE_LIMIT = 32_768;
const THUMBNAIL_PATH_CACHE_TTL_MS = 5 * 60_000;
const THUMBNAIL_MISS_CACHE_TTL_MS = 3_000;
const mediaPageCache = new Map<string, { at: number; result: NativeResult<MediaItem[]> }>();
const mediaInfoCache = new Map<string, { at: number; result: NativeResult<MediaPageInfo> }>();
const mediaFolderCache = new Map<string, { at: number; result: NativeResult<MediaFolder[]> }>();
const thumbnailPathCache = new Map<
  string,
  { at: number; result: NativeResult<string | null> }
>();
const thumbnailPathRequests = new Map<string, Promise<NativeResult<string | null>>>();
let thumbnailCacheGeneration = 0;
export const mediaThumbnailResolvedEvent = "pixvault:media-thumbnail-resolved";
let preferenceSnapshot: NativeResult<Record<string, unknown>> | undefined;
let preferenceSnapshotRequest: Promise<NativeResult<Record<string, unknown>>> | undefined;
let libraryRootsCache: { at: number; result: NativeResult<LibraryRoot[]> } | undefined;
let libraryRootsRequest: Promise<NativeResult<LibraryRoot[]>> | undefined;
let librarySummaryCache: { at: number; result: NativeResult<LibrarySummary> } | undefined;
let librarySummaryRequest: Promise<NativeResult<LibrarySummary>> | undefined;
let catalogOverviewGeneration = 0;

type MediaMutationOptions = {
  deferCacheInvalidation?: boolean;
};

function stableMediaQuery(query: MediaQuery): string {
  const kinds = query.kind
    ? (Array.isArray(query.kind) ? query.kind : [query.kind]).slice().sort()
    : [];
  return JSON.stringify({
    ...query,
    kind: kinds,
    tagIds: [...(query.tagIds ?? [])].sort(),
  });
}

function clearCatalogQueryCaches(includeFolders = true): void {
  mediaPageCache.clear();
  mediaInfoCache.clear();
  if (includeFolders) mediaFolderCache.clear();
  libraryRootsCache = undefined;
  librarySummaryCache = undefined;
  libraryRootsRequest = undefined;
  librarySummaryRequest = undefined;
  catalogOverviewGeneration += 1;
}

function clearThumbnailCaches(): void {
  thumbnailPathCache.clear();
  thumbnailPathRequests.clear();
  thumbnailCacheGeneration += 1;
}

function clearCatalogCaches(): void {
  clearCatalogQueryCaches();
  clearThumbnailCaches();
}

function isFavoriteOnlyCacheKey(cacheKey: string): boolean {
  try {
    return Boolean((JSON.parse(cacheKey) as { favoritesOnly?: boolean }).favoritesOnly);
  } catch {
    return false;
  }
}

export function patchFavoriteQueryCacheBatch(
  updates: ReadonlyArray<{ mediaId: string; isFavorite: boolean }>,
): void {
  const updatesById = new Map(
    updates.map((update) => [update.mediaId, update.isFavorite] as const),
  );
  if (updatesById.size === 0) return;
  // A normal gallery keeps the same membership/order when a star changes, so
  // patch only the matching records. A favorites-only query changes
  // membership and offsets; invalidate only those filtered entries.
  for (const [cacheKey, cached] of mediaPageCache) {
    if (isFavoriteOnlyCacheKey(cacheKey)) {
      mediaPageCache.delete(cacheKey);
      continue;
    }
    let changed = false;
    const data = cached.result.data.map((item) => {
      const isFavorite = updatesById.get(item.id);
      if (isFavorite === undefined || item.isFavorite === isFavorite) return item;
      changed = true;
      return { ...item, isFavorite };
    });
    if (!changed) continue;
    mediaPageCache.set(cacheKey, {
      ...cached,
      result: { ...cached.result, data },
    });
  }
  for (const cacheKey of mediaInfoCache.keys()) {
    if (isFavoriteOnlyCacheKey(cacheKey)) mediaInfoCache.delete(cacheKey);
  }
}

export function invalidateMediaCatalogCache(
  options: { preserveThumbnails?: boolean } = {},
): void {
  clearCatalogQueryCaches();
  if (!options.preserveThumbnails) clearThumbnailCaches();
}

function reportMissingMedia<T>(mediaId: string, result: NativeResult<T>): NativeResult<T> {
  const error = result.error?.toLocaleLowerCase("en-US");
  if (
    error
    && (
      error.includes("cannot resolve media path")
      || error.includes("指定されたファイルが見つかりません")
      || error.includes("os error 2")
    )
  ) {
    invalidateMediaCatalogCache({ preserveThumbnails: true });
    window.dispatchEvent(new CustomEvent("pixvault:media-missing", {
      detail: { mediaId },
    }));
  }
  return result;
}

export function invalidateMediaQueryCache(includeFolders = false): void {
  clearCatalogQueryCaches(includeFolders);
}

function rememberPage(
  key: string,
  result: NativeResult<MediaItem[]>,
): NativeResult<MediaItem[]> {
  mediaPageCache.delete(key);
  mediaPageCache.set(key, { at: Date.now(), result });
  while (mediaPageCache.size > MEDIA_PAGE_CACHE_LIMIT) {
    const oldest = mediaPageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    mediaPageCache.delete(oldest);
  }
  return result;
}

function rememberMediaInfo(
  key: string,
  result: NativeResult<MediaPageInfo>,
): NativeResult<MediaPageInfo> {
  mediaInfoCache.delete(key);
  mediaInfoCache.set(key, { at: Date.now(), result });
  while (mediaInfoCache.size > MEDIA_INFO_CACHE_LIMIT) {
    const oldest = mediaInfoCache.keys().next().value as string | undefined;
    if (!oldest) break;
    mediaInfoCache.delete(oldest);
  }
  return result;
}

function rememberThumbnailPath(
  mediaId: string,
  result: NativeResult<string | null>,
): NativeResult<string | null> {
  const previous = thumbnailPathCache.get(mediaId)?.result;
  const unchanged = previous?.data === result.data
    && previous?.available === result.available
    && previous?.error === result.error;
  thumbnailPathCache.delete(mediaId);
  thumbnailPathCache.set(mediaId, { at: Date.now(), result });
  while (thumbnailPathCache.size > THUMBNAIL_PATH_CACHE_LIMIT) {
    const oldest = thumbnailPathCache.keys().next().value as string | undefined;
    if (!oldest) break;
    thumbnailPathCache.delete(oldest);
  }
  if (!unchanged && result.data && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(mediaThumbnailResolvedEvent, {
      detail: { mediaId, path: result.data },
    }));
  }
  return result;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "ネイティブ処理から不明なエラーが返されました。";
}

async function loadPreferenceSnapshot(): Promise<NativeResult<Record<string, unknown>>> {
  if (preferenceSnapshot) return preferenceSnapshot;
  if (preferenceSnapshotRequest) return preferenceSnapshotRequest;
  preferenceSnapshotRequest = call<unknown>("get_preferences", undefined, [])
    .then((result) => {
      const data = Array.isArray(result.data)
        ? Object.fromEntries(
            result.data
              .map(record)
              .map((entry) => [text(entry.key), entry.value] as const)
              .filter(([key]) => Boolean(key)),
          )
        : record(result.data);
      const normalized: NativeResult<Record<string, unknown>> = { ...result, data };
      if (!normalized.error) preferenceSnapshot = normalized;
      return normalized;
    })
    .finally(() => { preferenceSnapshotRequest = undefined; });
  return preferenceSnapshotRequest;
}

function patchPreferenceSnapshot(key: string, value: unknown) {
  if (!preferenceSnapshot) return;
  preferenceSnapshot = {
    ...preferenceSnapshot,
    data: { ...preferenceSnapshot.data, [key]: value },
  };
}

async function call<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: T,
): Promise<NativeResult<T>> {
  if (!isTauriRuntime()) {
    return { data: fallback, available: false };
  }

  try {
    return {
      data: await invoke<T>(command, args),
      available: true,
    };
  } catch (error) {
    return {
      data: fallback,
      available: true,
      error: errorMessage(error),
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function timestampToIso(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeTag(value: unknown): Tag {
  const item = record(value);
  return {
    id: text(item.id, text(item.name)),
    name: text(item.name, "名称未設定"),
    color: text(item.color) || undefined,
    source: text(item.source) || undefined,
    confidence: Number.isFinite(Number(item.confidence))
      ? Math.max(0, Math.min(1, Number(item.confidence)))
      : undefined,
    aiCategory: text(item.aiCategory) || undefined,
  };
}

function inferKind(path: string, rawKind: unknown): MediaKind {
  const kind = text(rawKind).toLowerCase();
  if (
    kind === "image" ||
    kind === "gif" ||
    kind === "video" ||
    kind === "pdf" ||
    kind === "archive" ||
    kind === "document"
  ) {
    return kind;
  }

  if (kind === "zip") return "archive";

  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "gif") return "gif";
  if (["jpg", "jpeg", "png", "webp", "avif", "bmp", "heic"].includes(extension ?? "")) return "image";
  if (["mp4", "webm", "mov", "mkv", "avi"].includes(extension ?? "")) return "video";
  if (extension === "pdf") return "pdf";
  if (["zip", "cbz", "rar", "cbr", "7z"].includes(extension ?? "")) return "archive";
  if (["txt", "md", "doc", "docx"].includes(extension ?? "")) return "document";
  return "unknown";
}

function normalizeMedia(value: unknown): MediaItem {
  const item = record(value);
  const path = text(item.absolutePath, text(item.path));
  const rawTags = Array.isArray(item.tags) ? item.tags : [];
  return {
    id: text(item.id, path),
    rootId: text(item.rootId) || undefined,
    relativePath: text(item.relativePath) || undefined,
    path,
    name: text(item.name, path.split(/[\\/]/).pop() ?? "名称未設定"),
    kind: inferKind(path, item.kind),
    mimeType: text(item.mimeType) || undefined,
    thumbnailPath: text(item.thumbnailPath) || text(item.thumbnailUrl) || undefined,
    width: numberValue(item.width) || undefined,
    height: numberValue(item.height) || undefined,
    durationSeconds: numberValue(item.durationSeconds) || numberValue(item.durationMs) / 1000 || undefined,
    sizeBytes: numberValue(item.byteSize, numberValue(item.sizeBytes)),
    modifiedAt: timestampToIso(item.modifiedAt),
    importedAt: timestampToIso(item.importedAt),
    isFavorite: booleanValue(item.isFavorite, booleanValue(item.favorite)),
    ageRating: (["UNRATED", "SFW", "R15", "R18"].includes(text(item.ageRating).toUpperCase())
      ? text(item.ageRating).toUpperCase()
      : "UNRATED") as AgeRating,
    tags: rawTags.map(normalizeTag),
    pageCount: numberValue(item.pageCount) || undefined,
  };
}

function normalizeExternalMediaOpenBatch(value: unknown): ExternalMediaOpenBatch | null {
  if (!value || typeof value !== "object") return null;
  const batch = record(value);
  const requestId = text(batch.requestId);
  const items = Array.isArray(batch.items) ? batch.items.map(normalizeMedia) : [];
  if (!requestId || items.length === 0) return null;
  const requestedCurrentId = text(batch.currentId);
  return {
    requestId,
    items,
    currentId: items.some((item) => item.id === requestedCurrentId)
      ? requestedCurrentId
      : items[0].id,
  };
}

function normalizeRoot(value: unknown): LibraryRoot {
  const item = record(value);
  const path = text(item.path);
  return {
    id: text(item.id, path),
    path,
    displayName: text(item.displayName, path.split(/[\\/]/).filter(Boolean).pop() ?? path),
    createdAt: timestampToIso(item.createdAt),
    lastScannedAt: timestampToIso(item.lastScannedAt),
    mediaCount: numberValue(item.itemCount, numberValue(item.mediaCount)),
    isPriority: booleanValue(item.isPriority, true),
  };
}

function normalizeMediaFolder(value: unknown): MediaFolder {
  const item = record(value);
  const relativeFolder = text(item.relativeFolder);
  return {
    rootId: text(item.rootId),
    relativeFolder,
    displayName: text(
      item.displayName,
      relativeFolder.split("/").filter(Boolean).pop() ?? "ルート直下",
    ),
    itemCount: numberValue(item.itemCount),
  };
}

function normalizeFolderGroupMember(value: unknown): FolderGroupMember {
  const item = record(value);
  return {
    rootId: text(item.rootId),
    relativeFolder: text(item.relativeFolder),
    displayName: text(item.displayName, "ルート直下"),
    rootName: text(item.rootName, "登録フォルダー"),
    sortOrder: numberValue(item.sortOrder),
  };
}

function normalizeFolderGroup(value: unknown): FolderGroup {
  const item = record(value);
  return {
    id: text(item.id),
    name: text(item.name, "フォルダーグループ"),
    sortOrder: numberValue(item.sortOrder),
    createdAt: timestampToIso(item.createdAt) ?? "",
    updatedAt: timestampToIso(item.updatedAt) ?? "",
    members: Array.isArray(item.members)
      ? item.members.map(normalizeFolderGroupMember)
      : [],
  };
}

function normalizeSummary(value: unknown): LibrarySummary {
  const item = record(value);
  const kindCounts = new Map<string, number>(
    (Array.isArray(item.byKind) ? item.byKind : []).map((entry) => {
      const kind = record(entry);
      return [text(kind.kind), numberValue(kind.count)];
    }),
  );
  return {
    totalItems: numberValue(item.totalItems),
    images: kindCounts.get("image") ?? numberValue(item.images),
    gifs: kindCounts.get("gif") ?? numberValue(item.gifs),
    videos: kindCounts.get("video") ?? numberValue(item.videos),
    books: (kindCounts.get("pdf") ?? 0) + (kindCounts.get("zip") ?? 0) || numberValue(item.books),
    documents: numberValue(item.documents),
    favorites: numberValue(item.favoriteItems, numberValue(item.favorites)),
    tags: numberValue(item.tags),
    libraryRoots: numberValue(item.rootCount, numberValue(item.libraryRoots)),
    storageBytes: numberValue(item.totalBytes, numberValue(item.storageBytes)),
    lastScannedAt: timestampToIso(item.lastScannedAt),
  };
}

function normalizeRuntime(value: unknown): RuntimeInfo {
  const item = record(value);
  return {
    appName: text(item.appName, emptyRuntimeInfo.appName),
    appVersion: text(item.appVersion, emptyRuntimeInfo.appVersion),
    os: text(item.os, emptyRuntimeInfo.os),
    arch: text(item.arch, emptyRuntimeInfo.arch),
    databaseSchemaVersion: numberValue(
      item.databaseSchemaVersion,
      emptyRuntimeInfo.databaseSchemaVersion,
    ),
    migrationFormatVersion: numberValue(
      item.migrationFormatVersion,
      emptyRuntimeInfo.migrationFormatVersion,
    ),
    automaticUpdatesEnabled: Boolean(item.automaticUpdatesEnabled),
    updateHttpsEndpointConfigured: Boolean(item.updateHttpsEndpointConfigured),
    updatePublicKeyConfigured: Boolean(item.updatePublicKeyConfigured),
    windowsSigningCertificateConfigured: Boolean(item.windowsSigningCertificateConfigured),
  };
}

function normalizeSystemDiagnostics(value: unknown): SystemDiagnostics {
  const item = record(value);
  return {
    checkedAt: numberValue(item.checkedAt),
    status: item.status === "issues" ? "issues" : "healthy",
    quickCheckMessages: Array.isArray(item.quickCheckMessages)
      ? item.quickCheckMessages.filter((message): message is string => typeof message === "string")
      : [],
    foreignKeyIssues: numberValue(item.foreignKeyIssues),
    databaseSchemaVersion: numberValue(item.databaseSchemaVersion, 8),
    databaseBytes: numberValue(item.databaseBytes),
    walBytes: numberValue(item.walBytes),
    rootCount: numberValue(item.rootCount),
    mediaCount: numberValue(item.mediaCount),
    missingMediaCount: numberValue(item.missingMediaCount),
    lastCrashDetected: Boolean(item.lastCrashDetected),
    lastCrashSummary: typeof item.lastCrashSummary === "string" ? item.lastCrashSummary : undefined,
  };
}

function normalizeDiagnosticExport(value: unknown): DiagnosticExportResult | null {
  if (!value || typeof value !== "object") return null;
  const item = record(value);
  const path = text(item.path);
  return path ? { path, bytes: numberValue(item.bytes) } : null;
}

function normalizeRecoverySnapshot(value: unknown): RecoverySnapshotResult | null {
  const result = normalizeDiagnosticExport(value);
  if (!result) return null;
  return { ...result, sha256: text(record(value).sha256) };
}

async function normalizedCall<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: T,
  normalize: (value: unknown) => T,
): Promise<NativeResult<T>> {
  const result = await call<unknown>(command, args, fallback);
  return { ...result, data: normalize(result.data) };
}

export async function getRuntimeInfo(): Promise<NativeResult<RuntimeInfo>> {
  return normalizedCall("get_runtime_info", undefined, emptyRuntimeInfo, normalizeRuntime);
}

export async function recordDiagnosticEvent(
  event: "renderer-error" | "unhandled-rejection" | "renderer-recovered",
  message: string,
): Promise<NativeResult<boolean>> {
  return normalizedCall("record_diagnostic_event", { event, message }, false, Boolean);
}

export async function getSystemDiagnostics(): Promise<NativeResult<SystemDiagnostics>> {
  return normalizedCall(
    "get_system_diagnostics",
    undefined,
    emptySystemDiagnostics,
    normalizeSystemDiagnostics,
  );
}

export async function optimizeCatalog(): Promise<NativeResult<SystemDiagnostics>> {
  return normalizedCall(
    "optimize_catalog",
    undefined,
    emptySystemDiagnostics,
    normalizeSystemDiagnostics,
  );
}

export async function exportDiagnosticsReport(): Promise<NativeResult<DiagnosticExportResult | null>> {
  return normalizedCall(
    "export_diagnostics_report",
    undefined,
    null,
    normalizeDiagnosticExport,
  );
}

export async function createCatalogRecoverySnapshot(): Promise<NativeResult<RecoverySnapshotResult | null>> {
  return normalizedCall(
    "create_catalog_recovery_snapshot",
    undefined,
    null,
    normalizeRecoverySnapshot,
  );
}

export async function takePendingXUrl(): Promise<NativeResult<string | null>> {
  return normalizedCall(
    "take_pending_x_url",
    undefined,
    null,
    (value) => typeof value === "string" && value.trim() ? value.trim() : null,
  );
}

export async function takePendingExternalMedia(): Promise<NativeResult<ExternalMediaOpenBatch | null>> {
  return normalizedCall(
    "take_pending_external_media",
    undefined,
    null,
    normalizeExternalMediaOpenBatch,
  );
}

export async function showWindowsNotification(
  title: string,
  message: string,
  tone: "success" | "info" | "warning" | "error" = "info",
): Promise<NativeResult<boolean>> {
  return normalizedCall(
    "show_windows_notification",
    { title, message, tone },
    false,
    Boolean,
  );
}

export async function openInAppBrowser(
  url: string,
  bounds: InAppBrowserBounds,
): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("open_in_app_browser", { url, bounds }, null);
  return { ...result, data: result.available && !result.error };
}

export async function getInAppBrowserUrl(): Promise<NativeResult<string | null>> {
  return normalizedCall(
    "get_in_app_browser_url",
    undefined,
    null,
    (value) => (typeof value === "string" && value ? value : null),
  );
}

export async function setInAppBrowserBounds(
  bounds: InAppBrowserBounds,
): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("set_in_app_browser_bounds", { bounds }, null);
  return { ...result, data: result.available && !result.error };
}

export async function controlInAppBrowser(
  action: InAppBrowserAction,
): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("control_in_app_browser", { action }, null);
  return { ...result, data: result.available && !result.error };
}

export async function closeInAppBrowser(): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("close_in_app_browser", undefined, null);
  return { ...result, data: result.available && !result.error };
}

export async function listLibraryRoots(): Promise<NativeResult<LibraryRoot[]>> {
  if (
    libraryRootsCache
    && Date.now() - libraryRootsCache.at < LIBRARY_OVERVIEW_CACHE_TTL_MS
  ) return libraryRootsCache.result;
  if (libraryRootsRequest) return libraryRootsRequest;
  const generation = catalogOverviewGeneration;
  let request: Promise<NativeResult<LibraryRoot[]>>;
  request = normalizedCall(
    "list_library_roots",
    undefined,
    [],
    (value) => (Array.isArray(value) ? value.map(normalizeRoot) : []),
  ).then((result) => {
    if (!result.error && generation === catalogOverviewGeneration) {
      libraryRootsCache = { at: Date.now(), result };
    }
    return result;
  }).finally(() => {
    if (libraryRootsRequest === request) libraryRootsRequest = undefined;
  });
  libraryRootsRequest = request;
  return request;
}

export async function listMediaFolders(
  rootId?: string,
  kinds: MediaKind[] = [],
  options: { fresh?: boolean } = {},
): Promise<NativeResult<MediaFolder[]>> {
  const nativeKinds = [...new Set(kinds
    .map((kind) => (kind === "archive" ? "zip" : kind))
    .filter((kind): kind is "image" | "gif" | "video" | "pdf" | "zip" =>
      ["image", "gif", "video", "pdf", "zip"].includes(kind),
    ))];
  const cacheKey = `${rootId ?? "*"}:${nativeKinds.slice().sort().join(",")}`;
  const cached = mediaFolderCache.get(cacheKey);
  if (!options.fresh && cached && Date.now() - cached.at < MEDIA_INFO_CACHE_TTL_MS) {
    return cached.result;
  }
  const result = await call<unknown>(
    "list_media_folders",
    {
      rootId: rootId || null,
      kinds: nativeKinds.length > 0 ? nativeKinds : null,
      refreshPhysical: Boolean(options.fresh),
    },
    [],
  );
  const folders = Array.isArray(result.data)
    ? result.data.map(normalizeMediaFolder)
    : [];
  const normalized = {
    data: folders.sort((left, right) =>
      `${left.rootId}/${left.relativeFolder}`.localeCompare(
        `${right.rootId}/${right.relativeFolder}`,
        "ja",
      )),
    available: result.available,
    error: result.error,
  };
  if (!normalized.error) {
    mediaFolderCache.set(cacheKey, { at: Date.now(), result: normalized });
  }
  return normalized;
}

export async function listFolderGroups(): Promise<NativeResult<FolderGroup[]>> {
  return normalizedCall(
    "list_folder_groups",
    undefined,
    [],
    (value) => (Array.isArray(value) ? value.map(normalizeFolderGroup) : []),
  );
}

export async function saveFolderGroup(
  name: string,
  members: FolderGroupMemberInput[],
  groupId?: string,
): Promise<NativeResult<FolderGroup | null>> {
  return normalizedCall(
    "save_folder_group",
    { groupId: groupId ?? null, name, members },
    null,
    (value) => (value ? normalizeFolderGroup(value) : null),
  );
}

export async function deleteFolderGroup(groupId: string): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("delete_folder_group", { groupId }, null);
  const value = record(result.data);
  return { ...result, data: numberValue(value.affected) > 0 };
}

export async function reorderFolderGroups(orderedIds: string[]): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("reorder_folder_groups", { orderedIds }, null);
  return { ...result, data: result.available && !result.error };
}

export async function pickLibraryRoot(): Promise<NativeResult<string | null>> {
  return normalizedCall(
    "pick_library_root",
    undefined,
    null,
    (value) => (typeof value === "string" && value ? value : null),
  );
}

export async function pickDrawingReference(): Promise<NativeResult<string | null>> {
  return normalizedCall(
    "pick_drawing_reference",
    undefined,
    null,
    (value) => (typeof value === "string" && value ? value : null),
  );
}

export async function cacheTemporaryDrawingReference(
  projectId: string,
  referenceId: string,
  sourcePath: string,
): Promise<NativeResult<TemporaryReferenceCacheResult | null>> {
  return normalizedCall(
    "cache_temporary_drawing_reference",
    { projectId, referenceId, sourcePath },
    null,
    (value) => {
      const item = record(value);
      const path = text(item.path);
      return path ? { path, bytes: numberValue(item.bytes) } : null;
    },
  );
}

export async function cleanupTemporaryDrawingReferences(
  projectId: string,
  paths: string[],
): Promise<NativeResult<TemporaryReferenceCleanupResult | null>> {
  return normalizedCall(
    "cleanup_temporary_drawing_references",
    { projectId, paths },
    null,
    (value) => {
      const item = record(value);
      return {
        removed: numberValue(item.removed),
        missing: numberValue(item.missing),
      };
    },
  );
}

function normalizeMigrationIssue(value: unknown): MigrationIssue {
  const item = record(value);
  return {
    severity: item.severity === "error" ? "error" : "warning",
    entityType: text(item.entityType),
    sourceIdentity: text(item.sourceIdentity),
    message: text(item.message),
  };
}

function normalizeMigrationArchivePreview(value: unknown): MigrationArchivePreview | null {
  if (!value) return null;
  const item = record(value);
  return {
    token: text(item.token),
    sourceName: text(item.sourceName),
    sourceSha256: text(item.sourceSha256),
    androidVersion: text(item.androidVersion),
    exportedAt: text(item.exportedAt),
    totalMedia: numberValue(item.totalMedia),
    matchedMedia: numberValue(item.matchedMedia),
    ambiguousMedia: numberValue(item.ambiguousMedia),
    missingMedia: numberValue(item.missingMedia),
    matchedBookmarks: numberValue(item.matchedBookmarks),
    unmatchedBookmarks: numberValue(item.unmatchedBookmarks),
    tagRecords: numberValue(item.tagRecords),
    bookmarkRecords: numberValue(item.bookmarkRecords),
    referenceRecords: numberValue(item.referenceRecords),
    xHistoryRecords: numberValue(item.xHistoryRecords),
    settingsNamespaces: numberValue(item.settingsNamespaces),
    issueCount: numberValue(item.issueCount),
    alreadyImported: booleanValue(item.alreadyImported),
    issues: Array.isArray(item.issues)
      ? item.issues.map(normalizeMigrationIssue)
      : [],
    unresolvedMedia: (Array.isArray(item.unresolvedMedia) ? item.unresolvedMedia : []).map((value) => {
      const unresolved = record(value);
      return {
        sourceIdentity: text(unresolved.sourceIdentity),
        fileName: text(unresolved.fileName),
        relativePath: text(unresolved.relativePath) || undefined,
        fileSize: numberValue(unresolved.fileSize),
        status: unresolved.status === "ambiguous" ? "ambiguous" : "missing",
        candidates: (Array.isArray(unresolved.candidates) ? unresolved.candidates : []).map((candidateValue) => {
          const candidate = record(candidateValue);
          return {
            mediaId: text(candidate.mediaId),
            fileName: text(candidate.fileName),
            relativePath: text(candidate.relativePath),
            fileSize: numberValue(candidate.fileSize),
            modifiedAt: numberValue(candidate.modifiedAt),
          };
        }),
      };
    }),
  };
}

function normalizeMigrationImportResult(value: unknown): MigrationImportResult {
  const item = record(value);
  return {
    sourceName: text(item.sourceName),
    sourceSha256: text(item.sourceSha256),
    alreadyImported: booleanValue(item.alreadyImported),
    importedMedia: numberValue(item.importedMedia),
    importedFavorites: numberValue(item.importedFavorites),
    importedTags: numberValue(item.importedTags),
    importedBookmarks: numberValue(item.importedBookmarks),
    importedReferenceProjects: numberValue(item.importedReferenceProjects),
    importedReferenceItems: numberValue(item.importedReferenceItems),
    importedXHistory: numberValue(item.importedXHistory),
    importedSettingsNamespaces: numberValue(item.importedSettingsNamespaces),
    skippedMedia: numberValue(item.skippedMedia),
    issueCount: numberValue(item.issueCount),
  };
}

export async function pickAndroidMigrationArchive(): Promise<NativeResult<MigrationArchivePreview | null>> {
  return normalizedCall(
    "pick_android_migration_archive",
    undefined,
    null,
    normalizeMigrationArchivePreview,
  );
}

export async function commitAndroidMigrationArchive(
  token: string,
  resolutions: Record<string, string> = {},
): Promise<NativeResult<MigrationImportResult | null>> {
  return normalizedCall(
    "commit_android_migration_archive",
    { token, resolutions },
    null,
    (value) => (value ? normalizeMigrationImportResult(value) : null),
  );
}

function normalizeSettingsBackupResult(value: unknown): SettingsBackupResult | null {
  if (!value) return null;
  const item = record(value);
  return {
    path: text(item.path),
    preferences: numberValue(item.preferences),
  };
}

export async function exportSettingsBackup(): Promise<NativeResult<SettingsBackupResult | null>> {
  return normalizedCall(
    "export_settings_backup",
    undefined,
    null,
    normalizeSettingsBackupResult,
  );
}

export async function importSettingsBackup(): Promise<NativeResult<SettingsBackupResult | null>> {
  const result = await normalizedCall(
    "import_settings_backup",
    undefined,
    null,
    normalizeSettingsBackupResult,
  );
  if (result.data && !result.error) preferenceSnapshot = undefined;
  return result;
}

export async function getDefaultXDownloadDirectory(): Promise<NativeResult<string>> {
  return normalizedCall(
    "get_default_x_download_directory",
    undefined,
    "",
    (value) => text(value),
  );
}

export async function pickXDownloadFolder(): Promise<NativeResult<string | null>> {
  return normalizedCall(
    "pick_x_download_folder",
    undefined,
    null,
    (value) => (typeof value === "string" && value ? value : null),
  );
}

export async function getArchiveCover(mediaId: string): Promise<NativeResult<string | null>> {
  return reportMissingMedia(mediaId, await normalizedCall(
    "get_archive_cover",
    { mediaId },
    null,
    (value) => (typeof value === "string" && value ? value : null),
  ));
}

export async function getArchiveBookInfo(mediaId: string): Promise<NativeResult<ArchiveBookInfo | null>> {
  return reportMissingMedia(mediaId, await normalizedCall(
    "get_archive_book_info",
    { mediaId },
    null,
    (value) => {
      if (!value) return null;
      const item = record(value);
      return {
        pageCount: numberValue(item.pageCount),
        pageNames: Array.isArray(item.pageNames)
          ? item.pageNames.filter((name): name is string => typeof name === "string")
          : [],
      };
    },
  ));
}

export async function getArchiveBookPage(
  mediaId: string,
  pageIndex: number,
): Promise<NativeResult<string | null>> {
  return reportMissingMedia(mediaId, await normalizedCall(
    "get_archive_book_page",
    { mediaId, pageIndex },
    null,
    (value) => (typeof value === "string" && value ? value : null),
  ));
}

export async function precacheArchiveBookPages(
  mediaId: string,
  pageIndices: number[],
): Promise<NativeResult<ArchiveBookPageCacheEntry[]>> {
  return reportMissingMedia(mediaId, await normalizedCall(
    "precache_archive_book_pages",
    { mediaId, pageIndices },
    [],
    (value) => Array.isArray(value)
      ? value.map((rawEntry) => {
        const entry = record(rawEntry);
        return {
          pageIndex: Math.max(0, Math.trunc(numberValue(entry.pageIndex))),
          path: text(entry.path) || undefined,
          error: text(entry.error) || undefined,
        };
      })
      : [],
  ));
}

export async function getMediaThumbnail(mediaId: string): Promise<NativeResult<string | null>> {
  const cached = thumbnailPathCache.get(mediaId);
  const cacheTtl = cached?.result.data
    ? THUMBNAIL_PATH_CACHE_TTL_MS
    : THUMBNAIL_MISS_CACHE_TTL_MS;
  if (cached && Date.now() - cached.at < cacheTtl) {
    thumbnailPathCache.delete(mediaId);
    thumbnailPathCache.set(mediaId, cached);
    return cached.result;
  }

  const pending = thumbnailPathRequests.get(mediaId);
  if (pending) return pending;

  const generation = thumbnailCacheGeneration;
  let request: Promise<NativeResult<string | null>>;
  request = normalizedCall(
    "get_media_thumbnail",
    { mediaId },
    null,
    (value) => (typeof value === "string" && value ? value : null),
  ).then((result) => {
    const checked = reportMissingMedia(mediaId, result);
    return checked.error
      || generation !== thumbnailCacheGeneration
      || thumbnailPathRequests.get(mediaId) !== request
      ? checked
      : rememberThumbnailPath(mediaId, checked);
  });
  thumbnailPathRequests.set(mediaId, request);
  void request.finally(() => {
    if (thumbnailPathRequests.get(mediaId) === request) {
      thumbnailPathRequests.delete(mediaId);
    }
  });
  return request;
}

/**
 * Resolves multiple thumbnail paths through one native command. The native
 * cache is consulted first so revisiting a virtual range is normally an
 * entirely in-memory operation. `getMediaThumbnail` remains the compatibility
 * fallback for browser previews and older native builds.
 */
export async function getMediaThumbnails(
  mediaIds: readonly string[],
): Promise<NativeResult<MediaThumbnailLookup[]>> {
  const ids = [...new Set(mediaIds.filter(Boolean))];
  if (ids.length === 0) {
    return { data: [], available: isTauriRuntime() };
  }

  const now = Date.now();
  const resolved = new Map<string, string | null>();
  const unresolved: string[] = [];
  ids.forEach((mediaId) => {
    const cached = thumbnailPathCache.get(mediaId);
    const cacheTtl = cached?.result.data
      ? THUMBNAIL_PATH_CACHE_TTL_MS
      : THUMBNAIL_MISS_CACHE_TTL_MS;
    if (cached && now - cached.at < cacheTtl) {
      thumbnailPathCache.delete(mediaId);
      thumbnailPathCache.set(mediaId, cached);
      resolved.set(mediaId, cached.result.data);
    } else {
      unresolved.push(mediaId);
    }
  });

  let available = isTauriRuntime();
  let error: string | undefined;
  if (unresolved.length > 0) {
    const generation = thumbnailCacheGeneration;
    const batch = await normalizedCall(
      "get_media_thumbnails",
      { mediaIds: unresolved },
      [] as MediaThumbnailLookup[],
      (value) => Array.isArray(value)
        ? value.map((raw) => {
          const item = record(raw);
          const rawPath = item.thumbnailPath ?? item.thumbnail_path;
          return {
            mediaId: text(item.mediaId ?? item.media_id),
            thumbnailPath: typeof rawPath === "string" && rawPath ? rawPath : null,
          };
        }).filter((item) => item.mediaId)
        : [],
    );
    available = batch.available;
    error = batch.error;
    if (!batch.error) {
      const returned = new Map(batch.data.map((item) => [item.mediaId, item.thumbnailPath]));
      unresolved.forEach((mediaId) => {
        const thumbnailPath = returned.get(mediaId) ?? null;
        resolved.set(mediaId, thumbnailPath);
        if (generation === thumbnailCacheGeneration) {
          rememberThumbnailPath(mediaId, {
            data: thumbnailPath,
            available: batch.available,
          });
        }
      });
    }
  }

  return {
    data: ids
      .filter((mediaId) => resolved.has(mediaId))
      .map((mediaId) => ({ mediaId, thumbnailPath: resolved.get(mediaId) ?? null })),
    available,
    ...(error ? { error } : {}),
  };
}

export async function reportMediaLoadFailure(mediaId: string): Promise<NativeResult<boolean>> {
  const result = await call<boolean>("report_media_load_failure", { mediaId }, false);
  if (result.data) {
    invalidateMediaCatalogCache({ preserveThumbnails: true });
    window.dispatchEvent(new CustomEvent("pixvault:media-missing", {
      detail: { mediaId },
    }));
  }
  return result;
}

export async function getMediaImagePreview(mediaId: string): Promise<NativeResult<string | null>> {
  return reportMissingMedia(mediaId, await normalizedCall(
    "get_media_image_preview",
    { mediaId },
    null,
    (value) => (typeof value === "string" && value ? value : null),
  ));
}

export async function saveMediaThumbnail(mediaId: string, dataUrl: string): Promise<NativeResult<string | null>> {
  const result = await normalizedCall(
    "save_media_thumbnail",
    { mediaId, dataUrl },
    null,
    (value) => (typeof value === "string" && value ? value : null),
  );
  if (!result.error) {
    // Invalidate only an older lookup for this item. Advancing the global
    // generation here would discard every other thumbnail lookup in flight.
    thumbnailPathRequests.delete(mediaId);
    rememberThumbnailPath(mediaId, result);
  }
  return result;
}

export async function addLibraryRoot(path: string): Promise<NativeResult<LibraryRoot | null>> {
  const result = await normalizedCall(
    "add_library_root",
    { path },
    null,
    (value) => (value ? normalizeRoot(value) : null),
  );
  if (result.data) clearCatalogCaches();
  return result;
}

export async function removeLibraryRoot(rootId: string): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("remove_library_root", { rootId }, null);
  const normalized = { ...result, data: result.available && !result.error };
  if (normalized.data) clearCatalogCaches();
  return normalized;
}

export async function scanLibrary(rootId?: string): Promise<NativeResult<LibrarySummary>> {
  const scanResult = await call<unknown>("scan_library", rootId ? { rootId } : {}, null);
  if (!scanResult.available || scanResult.error) {
    return { ...scanResult, data: emptyLibrarySummary };
  }
  clearCatalogCaches();
  const summary = await getLibrarySummary();
  const report = record(scanResult.data);
  const issueCount = numberValue(report.issueCount);
  return { ...summary, error: summary.error ?? (issueCount > 0 ? `${issueCount}件の場所を読み取れませんでした。読み取れた範囲は反映済みです。接続やアクセス権を確認してください。` : undefined) };
}

export async function getLibrarySummary(): Promise<NativeResult<LibrarySummary>> {
  if (
    librarySummaryCache
    && Date.now() - librarySummaryCache.at < LIBRARY_OVERVIEW_CACHE_TTL_MS
  ) return librarySummaryCache.result;
  if (librarySummaryRequest) return librarySummaryRequest;
  const generation = catalogOverviewGeneration;
  let request: Promise<NativeResult<LibrarySummary>>;
  request = normalizedCall(
    "get_library_summary",
    undefined,
    emptyLibrarySummary,
    normalizeSummary,
  ).then((result) => {
    if (!result.error && generation === catalogOverviewGeneration) {
      librarySummaryCache = { at: Date.now(), result };
    }
    return result;
  }).finally(() => {
    if (librarySummaryRequest === request) librarySummaryRequest = undefined;
  });
  librarySummaryRequest = request;
  return request;
}

function nativeMediaQuery(query: MediaQuery): Record<string, unknown> {
  const requestedKinds = query.kind
    ? (Array.isArray(query.kind) ? query.kind : [query.kind])
    : [];
  const nativeKinds = requestedKinds
    .map((kind) => (kind === "archive" ? "zip" : kind))
    .filter((kind): kind is "image" | "gif" | "video" | "pdf" | "zip" =>
      ["image", "gif", "video", "pdf", "zip"].includes(kind),
    );
  return {
    rootId: query.rootId,
    folderPath: query.folderPath,
    search: query.search,
    ageRating: query.ageRating,
    tagIds: query.tagIds ?? [],
    modifiedFrom: query.modifiedFrom,
    modifiedBefore: query.modifiedBefore,
    favoriteOnly: Boolean(query.favoritesOnly),
    priorityOnly: Boolean(query.priorityOnly),
    includeMissing: false,
    sortBy: query.sortBy,
    sortDirection: query.sortDirection,
    includeDateGroups: Boolean(query.includeDateGroups),
    limit: query.limit ?? 500,
    offset: query.offset ?? 0,
    kinds: nativeKinds,
  };
}

export async function listMediaItems(
  query: MediaQuery = {},
  options: { fresh?: boolean } = {},
): Promise<NativeResult<MediaItem[]>> {
  const cacheKey = stableMediaQuery(query);
  const cached = mediaPageCache.get(cacheKey);
  if (!options.fresh && cached && Date.now() - cached.at < MEDIA_INFO_CACHE_TTL_MS) {
    mediaPageCache.delete(cacheKey);
    mediaPageCache.set(cacheKey, cached);
    return cached.result;
  }
  const generation = catalogOverviewGeneration;
  const result = await call<unknown>(
    "list_media_items",
    { query: nativeMediaQuery(query) },
    [],
  );
  const items = Array.isArray(result.data) ? result.data.map(normalizeMedia) : [];
  for (const item of items) {
    if (!item.thumbnailPath) continue;
    rememberThumbnailPath(item.id, {
      data: item.thumbnailPath,
      available: result.available,
    });
  }
  const normalized: NativeResult<MediaItem[]> = {
    data: items,
    available: result.available,
    error: result.error,
  };
  return normalized.error || generation !== catalogOverviewGeneration
    ? normalized
    : rememberPage(cacheKey, normalized);
}

export async function getVisualRecommendations(
  mediaId: string,
  limit = 25,
): Promise<NativeResult<VisualRecommendationResult>> {
  return normalizedCall(
    "get_visual_recommendations",
    { mediaId, limit },
    {
      recommendations: [],
      indexedCount: 0,
      candidateCount: 0,
      pending: false,
    },
    (value) => {
      const result = record(value);
      return {
        recommendations: (Array.isArray(result.recommendations)
          ? result.recommendations
          : []).flatMap((entry) => {
          const recommendation = record(entry);
          if (!recommendation.item) return [];
          return [{
            item: normalizeMedia(recommendation.item),
            similarity: Math.max(0, Math.min(1, numberValue(recommendation.similarity))),
          }];
        }),
        indexedCount: numberValue(result.indexedCount),
        candidateCount: numberValue(result.candidateCount),
        pending: booleanValue(result.pending),
      };
    },
  );
}

export async function getAdjacentSimilarityGroups(
  query: MediaQuery,
  threshold = 0.6,
): Promise<NativeResult<AdjacentSimilarityResult>> {
  return normalizedCall(
    "get_adjacent_similarity_groups",
    {
      query: nativeMediaQuery({ ...query, limit: undefined, offset: undefined }),
      threshold: Math.max(-1, Math.min(1, threshold)),
    },
    { groups: [], indexedCount: 0, candidateCount: 0, pending: false },
    (value) => {
      const result = record(value);
      return {
        groups: (Array.isArray(result.groups) ? result.groups : []).flatMap((groupValue) => {
          const group = record(groupValue);
          if (!group.representative) return [];
          return [{
            id: text(group.id),
            mediaIds: Array.isArray(group.mediaIds)
              ? group.mediaIds.map((id) => text(id)).filter(Boolean)
              : [],
            representative: normalizeMedia(group.representative),
            minimumSimilarity: Math.max(0, Math.min(1, numberValue(group.minimumSimilarity))),
          }];
        }),
        indexedCount: numberValue(result.indexedCount),
        candidateCount: numberValue(result.candidateCount),
        pending: booleanValue(result.pending),
      };
    },
  );
}

export async function getMediaItemsByIds(
  mediaIds: string[],
): Promise<NativeResult<MediaItem[]>> {
  return normalizedCall(
    "get_media_items_by_ids",
    { mediaIds },
    [],
    (value) => (Array.isArray(value) ? value.map(normalizeMedia) : []),
  );
}

export async function getMediaPageInfo(
  query: MediaQuery = {},
  options: { fresh?: boolean } = {},
): Promise<NativeResult<MediaPageInfo>> {
  const infoQuery = { ...query, limit: undefined, offset: undefined };
  const cacheKey = stableMediaQuery(infoQuery);
  const cached = mediaInfoCache.get(cacheKey);
  if (!options.fresh && cached && Date.now() - cached.at < MEDIA_INFO_CACHE_TTL_MS) {
    mediaInfoCache.delete(cacheKey);
    mediaInfoCache.set(cacheKey, cached);
    return cached.result;
  }
  const generation = catalogOverviewGeneration;
  const result = await call<unknown>(
    "get_media_page_info",
    { query: nativeMediaQuery(infoQuery) },
    { totalCount: 0, dateGroups: [] },
  );
  const raw = record(result.data);
  const normalized: NativeResult<MediaPageInfo> = {
    data: {
      totalCount: numberValue(raw.totalCount),
      dateGroups: (Array.isArray(raw.dateGroups) ? raw.dateGroups : []).map((entry) => {
        const group = record(entry);
        return {
          date: text(group.date, "1970-01-01"),
          itemCount: numberValue(group.itemCount),
        };
      }),
    },
    available: result.available,
    error: result.error,
  };
  if (!normalized.error && generation === catalogOverviewGeneration) {
    rememberMediaInfo(cacheKey, normalized);
  }
  return normalized;
}

export async function recycleMediaItem(
  mediaId: string,
  options: MediaMutationOptions = {},
): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("recycle_media_item", { mediaId }, null);
  const normalized = { ...result, data: result.available && !result.error };
  if (normalized.data && !options.deferCacheInvalidation) {
    clearCatalogQueryCaches();
    thumbnailPathCache.delete(mediaId);
    thumbnailPathRequests.delete(mediaId);
  }
  return normalized;
}

export async function openLibraryFolderInExplorer(
  rootId: string,
  relativePath = "",
): Promise<NativeResult<boolean>> {
  const result = await call<unknown>(
    "open_library_folder_in_explorer",
    { rootId, relativePath },
    null,
  );
  return { ...result, data: result.available && !result.error };
}

export async function revealMediaInExplorer(mediaId: string): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("reveal_media_in_explorer", { mediaId }, null);
  return { ...result, data: result.available && !result.error };
}

export async function setFavorite(
  mediaId: string,
  isFavorite: boolean,
  _options: MediaMutationOptions = {},
): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("set_favorite", { mediaId, isFavorite }, null);
  const normalized = { ...result, data: result.available && !result.error };
  if (normalized.data && !_options.deferCacheInvalidation) {
    patchFavoriteQueryCacheBatch([{ mediaId, isFavorite }]);
  }
  return normalized;
}

export async function setAgeRating(
  mediaId: string,
  ageRating: AgeRating,
  options: MediaMutationOptions = {},
): Promise<NativeResult<AgeRating>> {
  const result = await normalizedCall(
    "set_age_rating",
    { mediaId, ageRating },
    ageRating,
    (value) => (["UNRATED", "SFW", "R15", "R18"].includes(text(value).toUpperCase())
        ? text(value).toUpperCase()
        : ageRating) as AgeRating,
  );
  if (result.available && !result.error && !options.deferCacheInvalidation) {
    clearCatalogQueryCaches(false);
  }
  return result;
}

export async function listBookBookmarks(mediaId: string): Promise<NativeResult<BookBookmark[]>> {
  return normalizedCall(
    "list_book_bookmarks",
    { mediaId },
    [],
    (value) => (Array.isArray(value) ? value.map((entry) => {
      const item = record(entry);
      return {
        id: text(item.id),
        mediaId: text(item.mediaId),
        pageIndex: numberValue(item.pageIndex),
        label: text(item.label) || undefined,
        createdAt: timestampToIso(item.createdAt) ?? new Date(0).toISOString(),
      };
    }) : []),
  );
}

export async function setBookBookmark(
  mediaId: string,
  pageIndex: number,
  isBookmarked: boolean,
): Promise<NativeResult<boolean>> {
  const result = await call<unknown>(
    "set_book_bookmark",
    { mediaId, pageIndex, isBookmarked },
    null,
  );
  return { ...result, data: result.available && !result.error };
}

export async function saveCapture(
  dataUrl: string,
  suggestedName: string,
): Promise<NativeResult<string | null>> {
  return normalizedCall(
    "save_capture",
    { dataUrl, suggestedName },
    null,
    (value) => (typeof value === "string" && value ? value : null),
  );
}

export async function convertVideoToGif(
  mediaId: string,
): Promise<NativeResult<VideoGifConversionResult | null>> {
  const result = await normalizedCall(
    "convert_video_to_gif",
    { mediaId },
    null,
    (value) => {
      if (!value) return null;
      const item = record(value);
      const path = text(item.path);
      return path ? { path, catalogued: Boolean(item.catalogued) } : null;
    },
  );
  if (result.data?.catalogued) clearCatalogCaches();
  return result;
}

export async function setWallpaper(mediaId: string): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("set_wallpaper", { mediaId }, null);
  return { ...result, data: result.available && !result.error };
}

export async function searchAscii2d(mediaId: string): Promise<NativeResult<string | null>> {
  return normalizedCall(
    "search_ascii2d",
    { mediaId },
    null,
    (value) => (typeof value === "string" && value ? value : null),
  );
}

export async function listTags(): Promise<NativeResult<Tag[]>> {
  return normalizedCall(
    "list_tags",
    undefined,
    [],
    (value) => (Array.isArray(value) ? value.map(normalizeTag) : []),
  );
}

export async function upsertTag(tag: Partial<Tag> & Pick<Tag, "name">): Promise<NativeResult<Tag | null>> {
  return normalizedCall(
    "upsert_tag",
    { tag },
    null,
    (value) => (value ? normalizeTag(value) : null),
  );
}

export async function setMediaTags(
  mediaId: string,
  tagIds: string[],
  options: MediaMutationOptions = {},
): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("set_media_tags", { mediaId, tagIds }, null);
  const normalized = { ...result, data: result.available && !result.error };
  if (normalized.data && !options.deferCacheInvalidation) clearCatalogQueryCaches(false);
  return normalized;
}

export async function getPreferences(): Promise<NativeResult<UserPreferences>> {
  if (!isTauriRuntime()) return { data: defaultPreferences, available: false };
  const result = await loadPreferenceSnapshot();
  return {
    ...result,
    data: { ...defaultPreferences, ...result.data } as UserPreferences,
  };
}

export async function setPreference<K extends keyof UserPreferences>(
  key: K,
  value: UserPreferences[K],
): Promise<NativeResult<boolean>> {
  const preferenceKey = String(key);
  const result = await call<unknown>("set_preference", { key: preferenceKey, value }, null);
  const normalized = { ...result, data: result.available && !result.error };
  if (normalized.data) patchPreferenceSnapshot(preferenceKey, value);
  return normalized;
}

export async function getJsonPreference<T>(key: string, fallback: T): Promise<NativeResult<T>> {
  if (!isTauriRuntime()) {
    try {
      const stored = window.localStorage.getItem(`pixvault.preview.${key}`);
      return {
        data: stored === null ? fallback : JSON.parse(stored) as T,
        available: false,
      };
    } catch {
      return { data: fallback, available: false };
    }
  }
  const result = await loadPreferenceSnapshot();
  return {
    ...result,
    data: Object.prototype.hasOwnProperty.call(result.data, key)
      ? result.data[key] as T
      : fallback,
  };
}

export async function setJsonPreference<T>(key: string, value: T): Promise<NativeResult<boolean>> {
  if (!isTauriRuntime()) {
    try {
      window.localStorage.setItem(`pixvault.preview.${key}`, JSON.stringify(value));
      return { data: true, available: false };
    } catch (error) {
      return { data: false, available: false, error: errorMessage(error) };
    }
  }
  const result = await call<unknown>("set_preference", { key, value }, null);
  const normalized = { ...result, data: result.available && !result.error };
  if (normalized.data) patchPreferenceSnapshot(key, value);
  return normalized;
}

function normalizeXHistoryItem(value: unknown, fallback?: Partial<XHistoryItem>): XHistoryItem {
  const item = record(value);
  const rawStatus = text(item.status);
  const status: XHistoryItem["status"] =
    rawStatus === "completed" || rawStatus === "saved"
      ? "saved"
      : rawStatus === "failed"
        ? "failed"
        : "queued";
  return {
    id: text(item.id, fallback?.id ?? text(item.sourceUrl)),
    url: text(item.sourceUrl, fallback?.url ?? text(item.url)),
    title: text(item.postText, fallback?.title ?? text(item.title)) || undefined,
    author: text(item.author, fallback?.author ?? "") || undefined,
    previewUrl:
      text(item.mediaUrl, fallback?.previewUrl ?? text(item.previewUrl)) || undefined,
    status,
    savedPath: text(item.localPath, fallback?.savedPath ?? text(item.savedPath)) || undefined,
    createdAt:
      timestampToIso(item.createdAt) ??
      fallback?.createdAt ??
      new Date(0).toISOString(),
    error: text(item.errorMessage, fallback?.error ?? text(item.error)) || undefined,
  };
}

export async function listXHistory(): Promise<NativeResult<XHistoryItem[]>> {
  return normalizedCall(
    "list_x_history",
    undefined,
    [],
    (value) => (Array.isArray(value) ? value : []).map((raw) => normalizeXHistoryItem(raw)),
  );
}

export async function deleteXHistory(historyId: string): Promise<NativeResult<boolean>> {
  const result = await call<unknown>("delete_x_history", { historyId }, null);
  const affected = numberValue(record(result.data).affected);
  return { ...result, data: result.available && !result.error && affected > 0 };
}

function normalizeXMediaVariant(value: unknown): XMediaVariant {
  const item = record(value);
  return {
    id: text(item.id),
    label: text(item.label, "利用可能な画質"),
    url: text(item.url),
    extension: text(item.extension, "bin"),
    width: typeof item.width === "number" ? item.width : undefined,
    height: typeof item.height === "number" ? item.height : undefined,
    bitrate: typeof item.bitrate === "number" ? item.bitrate : undefined,
  };
}

function normalizeXPostInspection(value: unknown): XPostInspection | null {
  if (!value) return null;
  const item = record(value);
  const media: XMediaChoice[] = (Array.isArray(item.media) ? item.media : [])
    .map((raw) => {
      const choice = record(raw);
      const rawKind = text(choice.kind);
      const kind: XMediaKind =
        rawKind === "gif" || rawKind === "video" ? rawKind : "image";
      return {
        id: text(choice.id),
        kind,
        previewUrl: text(choice.previewUrl),
        width: typeof choice.width === "number" ? choice.width : undefined,
        height: typeof choice.height === "number" ? choice.height : undefined,
        variants: (Array.isArray(choice.variants) ? choice.variants : [])
          .map(normalizeXMediaVariant)
          .filter((variant) => variant.id && variant.url),
        alreadyDownloaded: Boolean(choice.alreadyDownloaded),
        existingPath: text(choice.existingPath) || undefined,
      };
    })
    .filter((choice) => choice.id && choice.variants.length > 0);
  return {
    sourceUrl: text(item.sourceUrl),
    postId: text(item.postId),
    author: text(item.author, "x"),
    postText: text(item.postText),
    media,
  };
}

export async function inspectXPost(
  url: string,
  destination?: string,
): Promise<NativeResult<XPostInspection | null>> {
  return normalizedCall(
    "inspect_x_post",
    { sourceUrl: url, destination: destination?.trim() || null },
    null,
    normalizeXPostInspection,
  );
}

export async function downloadXPost(
  url: string,
  destination: string,
  selections?: XMediaSelection[],
): Promise<NativeResult<XDownloadResult | null>> {
  return normalizedCall(
    "download_x_post",
    { sourceUrl: url, destination, selections: selections ?? null },
    null,
    (value) => {
      if (!value) return null;
      const result = record(value);
      return {
        history: normalizeXHistoryItem(result.history, {
          url,
          createdAt: new Date().toISOString(),
        }),
        files: Array.isArray(result.files)
          ? result.files.filter((path): path is string => typeof path === "string")
          : [],
        mediaCount: numberValue(result.mediaCount),
        duplicateCount: numberValue(result.duplicateCount),
        duplicatePaths: Array.isArray(result.duplicatePaths)
          ? result.duplicatePaths.filter((path): path is string => typeof path === "string")
          : [],
        media: (Array.isArray(result.media) ? result.media : [])
          .map((raw) => {
            const item = record(raw);
            const kind = text(item.kind);
            return {
              mediaId: text(item.mediaId),
              kind: (
                kind === "image" || kind === "gif" || kind === "video"
                  ? kind
                  : "image"
              ) as XMediaKind,
              path: text(item.path),
              finalPath: text(item.finalPath) || undefined,
              gifFinalizeToken: text(item.gifFinalizeToken) || undefined,
            };
          })
          .filter((item) => item.mediaId && item.path),
      };
    },
  );
}

export async function finalizeXGif(
  token: string,
): Promise<NativeResult<XGifFinalizeResult | null>> {
  if (!isTauriRuntime()) {
    return { data: null, available: false, error: "GIF変換はインストール版で利用できます" };
  }
  try {
    const value = await invoke<unknown>("finalize_x_gif", { token });
    const result = record(value);
    const historyValue = result.history;
    return {
      data: {
        path: text(result.path),
        history:
          historyValue && typeof historyValue === "object"
            ? normalizeXHistoryItem(historyValue)
            : undefined,
        removedSource: Boolean(result.removedSource),
      },
      available: true,
    };
  } catch (error) {
    return { data: null, available: true, error: errorMessage(error) };
  }
}

export async function failXGifFinalization(
  token: string,
  message: string,
): Promise<NativeResult<XHistoryItem | null>> {
  return normalizedCall(
    "fail_x_gif_finalization",
    { token, message },
    null,
    (value) => (value ? normalizeXHistoryItem(value) : null),
  );
}

export async function upsertXHistory(item: XHistoryItem): Promise<NativeResult<XHistoryItem | null>> {
  return normalizedCall(
    "upsert_x_history",
    {
      item: {
        id: item.id || undefined,
        sourceUrl: item.url,
        mediaUrl: item.previewUrl ?? null,
        localPath: item.savedPath ?? null,
        author: item.author ?? null,
        postText: item.title ?? null,
        status: item.status === "saved" ? "completed" : item.status,
        errorMessage: item.error ?? null,
        createdAt: Date.parse(item.createdAt) || undefined,
        completedAt: item.status === "saved" ? Date.now() : null,
      },
    },
    null,
    (value) => {
      const normalized = value ? record(value) : null;
      if (!normalized) return null;
      return normalizeXHistoryItem(normalized, item);
    },
  );
}

export async function importCatalogData(payload: unknown): Promise<NativeResult<ImportCatalogResult>> {
  return normalizedCall(
    "import_catalog_data",
    { payload },
    {
      importedFavorites: 0,
      importedTags: 0,
      importedSettings: 0,
      importedXHistory: 0,
      unmatchedMedia: 0,
    },
    (value) => {
      const item = record(value);
      return {
        importedFavorites: numberValue(item.importedFavorites),
        importedTags: numberValue(item.importedTags),
        importedSettings: numberValue(item.importedSettings),
        importedXHistory: numberValue(item.importedXHistory),
        unmatchedMedia: numberValue(item.unmatchedMedia),
      };
    },
  );
}

export function mediaAssetUrl(item: MediaItem): string | undefined {
  const url = localAssetUrl(item.path);
  if (!url || /^(data:|blob:)/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(`${item.modifiedAt ?? ""}-${item.sizeBytes}`)}`;
}

export function localAssetUrl(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  if (!isTauriRuntime()) return undefined;

  try {
    return convertFileSrc(path);
  } catch {
    return undefined;
  }
}
