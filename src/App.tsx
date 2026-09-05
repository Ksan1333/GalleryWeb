import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { HomeShelves } from "./components/HomeShelves";
import { Icon, type IconName } from "./components/Icon";
import { OperationTray } from "./components/OperationTray";
import { NotificationCenter } from "./components/NotificationCenter";
import {
  defaultGalleryMediaVisibility,
  galleryMediaVisibilityEvent,
  loadGalleryMediaVisibility,
  normalizeGalleryMediaVisibility,
  type GalleryMediaVisibility,
} from "./services/galleryMediaVisibility";
import { SelectMenu } from "./components/Ui";
import { useAiOperationBridge } from "./hooks/useAiOperationBridge";
import { useThumbnailCacheOperationBridge } from "./hooks/useThumbnailCacheOperationBridge";
import { useExternalMediaOpen } from "./hooks/useExternalMediaOpen";
import { externalExplorerTarget, joinFolderPath, type ExplorerRequest } from "./services/explorerNavigation";
import {
  addLibraryRoot,
  emptyLibrarySummary,
  getLibrarySummary,
  getJsonPreference,
  getPreferences,
  getRuntimeInfo,
  invalidateMediaCatalogCache,
  listLibraryRoots,
  listMediaItems,
  pickLibraryRoot,
  setFolderPriority,
  scanLibrary,
  setJsonPreference,
  takePendingXUrl,
  type ExternalMediaOpenBatch,
  type LibraryRoot,
  type LibrarySummary,
  type MediaKind,
  type MediaItem,
  type RuntimeInfo,
  type ViewerInfoLayout,
} from "./services/native";
import {
  rememberFolderNavigation,
  setFolderFavorite,
  type FolderActivityRecord,
} from "./services/folderActivity";
import { operationErrorMessage, startOperation } from "./services/operations";
import {
  tagGalleryNavigationEvent,
  type TagGalleryNavigationRequest,
} from "./services/galleryNavigation";
import {
  openAiAnalysisPanelEvent,
  type AiAnalysisPanelRequest,
} from "./services/aiPanel";
import { applyThemePreferences } from "./services/theme";
import { configureNativeNotifications, notifyApp } from "./services/notifications";

const MediaViewer = lazy(() => import("./components/MediaViewer").then((module) => ({ default: module.MediaViewer })));
const ReleaseHistory = lazy(() => import("./components/ReleaseHistory").then((module) => ({ default: module.ReleaseHistory })));
const AiAnalysisMonitor = lazy(() => import("./components/AiAnalysisMonitor").then((module) => ({ default: module.AiAnalysisMonitor })));
const FirstRunTutorial = lazy(() => import("./components/FirstRunTutorial").then((module) => ({ default: module.FirstRunTutorial })));
const MediaCollection = lazy(() => import("./components/MediaCollection").then((module) => ({ default: module.MediaCollection })));
const FolderMediaCollection = lazy(() => import("./components/MediaCollection").then((module) => ({ default: module.FolderMediaCollection })));
const FileSystemBrowser = lazy(() => import("./components/FileSystemBrowser").then((module) => ({ default: module.FileSystemBrowser })));
const AIAnalysisModal = lazy(() => import("./components/AIAnalysisModal").then((module) => ({ default: module.AIAnalysisModal })));
const FavoriteSitesPage = lazy(() => import("./components/ExtraPages").then((module) => ({ default: module.FavoriteSitesPage })));
const FavoriteCreatorsPage = lazy(() => import("./components/ExtraPages").then((module) => ({ default: module.FavoriteCreatorsPage })));
const DrawingReferencesPage = lazy(() => import("./components/ExtraPages").then((module) => ({ default: module.DrawingReferencesPage })));
const XDownloaderPage = lazy(() => import("./components/ExtraPages").then((module) => ({ default: module.XDownloaderPage })));
const BookViewerSettings = lazy(() => import("./components/BookViewerSettings").then((module) => ({ default: module.BookViewerSettings })));
const VideoViewerSettings = lazy(() => import("./components/VideoViewerSettings").then((module) => ({ default: module.VideoViewerSettings })));
const GalleryMediaSettings = lazy(() => import("./components/GalleryMediaSettings").then((module) => ({ default: module.GalleryMediaSettings })));
const GalleryDisplaySettings = lazy(() => import("./components/GalleryDisplaySettings").then((module) => ({ default: module.GalleryDisplaySettings })));
const XDownloadDirectorySetting = lazy(() => import("./components/XDownloadDirectorySetting").then((module) => ({ default: module.XDownloadDirectorySetting })));
const DataPortabilitySettings = lazy(() => import("./components/DataPortabilitySettings").then((module) => ({ default: module.DataPortabilitySettings })));
const GeneralSettings = lazy(() => import("./components/GeneralSettings").then((module) => ({ default: module.GeneralSettings })));
const DiagnosticSettings = lazy(() => import("./components/DiagnosticSettings").then((module) => ({ default: module.DiagnosticSettings })));
const SearchAndGroupingSettings = lazy(() => import("./components/SearchAndGroupingSettings").then((module) => ({ default: module.SearchAndGroupingSettings })));
const ViewerControlSettings = lazy(() => import("./components/ViewerControlSettings").then((module) => ({ default: module.ViewerControlSettings })));

type Section = "home" | "gallery" | "allFolders" | "folders" | "videos" | "books" | "favorites" | "sites" | "creators" | "references" | "downloads" | "settings" | "about" | "changelog";

type NavigationItem = {
  id: Section;
  label: string;
  icon: IconName;
};

const IMAGE_MEDIA_KINDS: MediaKind[] = ["image", "gif"];
const VIDEO_MEDIA_KINDS: MediaKind[] = ["video"];
const BOOK_MEDIA_KINDS: MediaKind[] = ["pdf", "archive"];

function extractXPostUrl(value: string): string | undefined {
  return value.match(/https:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[^\s<>]+\/status\/\d+/i)?.[0];
}

const navigationGroups: Array<{ label?: string; items: NavigationItem[] }> = [
  {
    items: [
      { id: "home", label: "ホーム", icon: "home" },
      { id: "gallery", label: "ギャラリー", icon: "gallery" },
      { id: "allFolders", label: "全フォルダー", icon: "folder" },
      { id: "favorites", label: "お気に入り", icon: "star" },
    ],
  },
  {
    label: "メディア",
    items: [
      { id: "folders", label: "画像", icon: "image" },
      { id: "videos", label: "動画", icon: "video" },
      { id: "books", label: "ブック", icon: "book" },
    ],
  },
  {
    label: "便利機能",
    items: [
      { id: "sites", label: "お気に入りサイト", icon: "external" },
      { id: "creators", label: "お気に入りクリエイター", icon: "sparkles" },
      { id: "references", label: "お絵描き資料", icon: "reference" },
      { id: "downloads", label: "X ダウンローダー", icon: "download" },
    ],
  },
  {
    label: "情報",
    items: [
      { id: "settings", label: "設定", icon: "settings" },
      { id: "about", label: "このアプリについて", icon: "info" },
      { id: "changelog", label: "更新履歴", icon: "clock" },
    ],
  },
];
const navigation = navigationGroups.flatMap((group) => group.items);

const sectionDetails: Record<Section, { eyebrow: string; description: string }> = {
  home: { eyebrow: "LIBRARY DESK", description: "今日のライブラリをひと目で確認" },
  gallery: { eyebrow: "GALLERY", description: "優先フォルダーのメディアを探す" },
  allFolders: { eyebrow: "MEDIA FOLDERS", description: "すべての形式をフォルダー単位で移動" },
  folders: { eyebrow: "IMAGES", description: "画像とGIFをフォルダー単位で整理" },
  videos: { eyebrow: "VIDEOS", description: "動画をフォルダー単位で整理" },
  books: { eyebrow: "BOOKS", description: "PDF・ZIP・CBZをまとめて読む" },
  favorites: { eyebrow: "FAVORITES", description: "大切なメディアへすぐ戻る" },
  sites: { eyebrow: "WEB LINKS", description: "よく使うサイトをまとめて開く" },
  creators: { eyebrow: "CREATORS", description: "お気に入りの作者を追いかける" },
  references: { eyebrow: "REFERENCES", description: "制作資料をプロジェクト別に整理" },
  downloads: { eyebrow: "X DOWNLOADER", description: "投稿URLからメディアを保存" },
  settings: { eyebrow: "PREFERENCES", description: "PixVaultの動作と表示を調整" },
  about: { eyebrow: "ABOUT", description: "アプリと実行環境の情報" },
  changelog: { eyebrow: "RELEASE NOTES", description: "これまでの改善内容を確認" },
};

function messageFrom(...messages: Array<string | undefined>): string | undefined {
  return messages.find((message) => Boolean(message));
}

function scheduleDeferredUi(callback: () => void): () => void {
  const idleWindow = window as Partial<Window>;
  let idleId: number | undefined;
  // An idle callback alone may fire immediately while the first catalog IPC
  // is in flight, putting optional modules back on the startup critical path.
  const timerId = globalThis.setTimeout(() => {
    if (idleWindow.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(callback, { timeout: 1_500 });
    } else callback();
  }, 750);
  return () => {
    globalThis.clearTimeout(timerId);
    if (idleId !== undefined) idleWindow.cancelIdleCallback?.(idleId);
  };
}

function App() {
  useAiOperationBridge();
  useThumbnailCacheOperationBridge();
  const [section, setSection] = useState<Section>("home");
  const sectionRef = useRef<Section>("home");
  const sectionBackStack = useRef<Section[]>([]);
  const sectionForwardStack = useRef<Section[]>([]);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo>();
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [summary, setSummary] = useState<LibrarySummary>(emptyLibrarySummary);
  const [homeFavoriteMedia, setHomeFavoriteMedia] = useState<MediaItem[]>([]);
  const [homeMediaLoading, setHomeMediaLoading] = useState(true);
  const [homeSelectedMediaId, setHomeSelectedMediaId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sidebarMinimized, setSidebarMinimized] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [error, setError] = useState<string>();
  const [viewerInfoLayout, setViewerInfoLayout] = useState<ViewerInfoLayout>("sidebar");
  const [savingViewerInfoLayout, setSavingViewerInfoLayout] = useState(false);
  const [galleryMediaVisibility, setGalleryMediaVisibility] = useState<GalleryMediaVisibility>(
    defaultGalleryMediaVisibility,
  );
  const [tagGalleryNavigation, setTagGalleryNavigation] =
    useState<TagGalleryNavigationRequest>();
  const [aiAnalysisPanelRequest, setAiAnalysisPanelRequest] =
    useState<(AiAnalysisPanelRequest & { requestId: number })>();
  const [catalogRefreshVersion, setCatalogRefreshVersion] = useState(0);
  const [externalXUrl, setExternalXUrl] = useState<string>();
  const [externalMediaBatch, setExternalMediaBatch] = useState<ExternalMediaOpenBatch>();
  const [explorerNavigationRequest, setExplorerNavigationRequest] = useState<ExplorerRequest>();
  const externalTarget = useMemo(() => externalMediaBatch ? externalExplorerTarget(externalMediaBatch) : undefined, [externalMediaBatch]);
  const [backgroundUiReady, setBackgroundUiReady] = useState(false);
  const [tutorialReopenRequestId, setTutorialReopenRequestId] = useState(0);

  useEffect(() => scheduleDeferredUi(() => setBackgroundUiReady(true)), []);

  useEffect(() => {
    let active = true;
    void getPreferences().then((result) => {
      if (!active) return;
      applyThemePreferences(result.data);
      configureNativeNotifications(result.data.nativeNotifications);
    });
    return () => {
      active = false;
    };
  }, []);
  const activeLabel = navigation.find((item) => item.id === section)?.label ?? "ホーム";
  const activeDetails = sectionDetails[section];
  const galleryMediaKinds = useMemo<MediaKind[]>(() => [
    ...IMAGE_MEDIA_KINDS,
    ...(galleryMediaVisibility.video ? VIDEO_MEDIA_KINDS : []),
    ...(galleryMediaVisibility.book ? BOOK_MEDIA_KINDS : []),
  ], [galleryMediaVisibility.book, galleryMediaVisibility.video]);

  useEffect(() => {
    let active = true;
    void getJsonPreference<boolean>("sidebarMinimized", false).then((result) => {
      if (active) setSidebarMinimized(Boolean(result.data));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleOpenAiAnalysis = (event: Event) => {
      const detail = (event as CustomEvent<AiAnalysisPanelRequest>).detail ?? {};
      setAiAnalysisPanelRequest({ ...detail, requestId: Date.now() });
    };
    window.addEventListener(openAiAnalysisPanelEvent, handleOpenAiAnalysis);
    return () => window.removeEventListener(openAiAnalysisPanelEvent, handleOpenAiAnalysis);
  }, []);

  useEffect(() => {
    let active = true;
    void getJsonPreference<ViewerInfoLayout>("viewerInfoLayout", "sidebar").then((result) => {
      if (!active) return;
      setViewerInfoLayout(result.data === "bottomSheet" ? "bottomSheet" : "sidebar");
      if (result.error) setError(result.error);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleViewerLayout = (event: Event) => {
      const detail = (event as CustomEvent<ViewerInfoLayout>).detail;
      if (detail === "sidebar" || detail === "bottomSheet") {
        setViewerInfoLayout(detail);
      }
    };
    window.addEventListener("pixvault:viewer-info-layout", handleViewerLayout);
    return () => window.removeEventListener("pixvault:viewer-info-layout", handleViewerLayout);
  }, []);

  useEffect(() => {
    let active = true;
    void loadGalleryMediaVisibility().then((value) => {
      if (active) setGalleryMediaVisibility(value);
    });
    const handleVisibility = (event: Event) => {
      setGalleryMediaVisibility(
        normalizeGalleryMediaVisibility(
          (event as CustomEvent<Partial<GalleryMediaVisibility>>).detail,
        ),
      );
    };
    window.addEventListener(galleryMediaVisibilityEvent, handleVisibility);
    return () => {
      active = false;
      window.removeEventListener(galleryMediaVisibilityEvent, handleVisibility);
    };
  }, []);

  useEffect(() => {
    const suppressNativeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppressNativeContextMenu, true);
    return () => window.removeEventListener("contextmenu", suppressNativeContextMenu, true);
  }, []);

  const changeViewerInfoLayout = useCallback(async (value: string) => {
    const next: ViewerInfoLayout = value === "bottomSheet" ? "bottomSheet" : "sidebar";
    const previous = viewerInfoLayout;
    setViewerInfoLayout(next);
    setSavingViewerInfoLayout(true);
    const result = await setJsonPreference("viewerInfoLayout", next);
    setSavingViewerInfoLayout(false);
    if (!result.data || result.error) {
      setViewerInfoLayout(previous);
      setError(result.error ?? "ビュワーの表示設定を保存できませんでした。");
    }
  }, [viewerInfoLayout]);

  const navigateToSection = useCallback((nextSection: Section) => {
    setMobileNavigationOpen(false);
    if (nextSection !== "allFolders") {
      setExternalMediaBatch(undefined);
      setExplorerNavigationRequest(undefined);
    }
    const currentSection = sectionRef.current;
    if (currentSection === nextSection) return;
    sectionBackStack.current.push(currentSection);
    sectionForwardStack.current = [];
    sectionRef.current = nextSection;
    setSection(nextSection);
  }, []);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavigationOpen]);

  useEffect(() => {
    const handleTagGalleryNavigation = (event: Event) => {
      const detail = (event as CustomEvent<TagGalleryNavigationRequest>).detail;
      if (!detail?.tagId || !detail.tagName) return;
      setTagGalleryNavigation(detail);
      navigateToSection("gallery");
    };
    window.addEventListener(tagGalleryNavigationEvent, handleTagGalleryNavigation);
    return () => window.removeEventListener(
      tagGalleryNavigationEvent,
      handleTagGalleryNavigation,
    );
  }, [navigateToSection]);

  const navigateBack = useCallback(() => {
    const detail = { handled: false };
    const request = new CustomEvent("pixvault:navigate-back", {
      cancelable: true,
      detail,
    });
    window.dispatchEvent(request);

    queueMicrotask(() => {
      if (request.defaultPrevented || detail.handled) return;
      const previousSection = sectionBackStack.current.pop();
      if (!previousSection) return;
      sectionForwardStack.current.push(sectionRef.current);
      sectionRef.current = previousSection;
      setSection(previousSection);
    });
  }, []);

  const navigateForward = useCallback(() => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    const detail = { handled: false };
    const request = new CustomEvent("pixvault:navigate-forward", {
      cancelable: true,
      detail,
    });
    window.dispatchEvent(request);

    queueMicrotask(() => {
      if (request.defaultPrevented || detail.handled) return;
      const nextSection = sectionForwardStack.current.pop();
      if (!nextSection) return;
      sectionBackStack.current.push(sectionRef.current);
      sectionRef.current = nextSection;
      setSection(nextSection);
    });
  }, []);

  useEffect(() => {
    const handleHistoryMouseButton = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 3) navigateBack();
      else navigateForward();
    };
    window.addEventListener("mouseup", handleHistoryMouseButton, true);
    return () => window.removeEventListener("mouseup", handleHistoryMouseButton, true);
  }, [navigateBack, navigateForward]);

  useEffect(() => {
    const handleBackRequest = () => navigateBack();
    const handleForwardRequest = () => navigateForward();
    const handleHistoryBranch = () => {
      sectionForwardStack.current = [];
    };
    window.addEventListener("pixvault:history-back", handleBackRequest);
    window.addEventListener("pixvault:history-forward", handleForwardRequest);
    window.addEventListener("pixvault:history-branch", handleHistoryBranch);
    return () => {
      window.removeEventListener("pixvault:history-back", handleBackRequest);
      window.removeEventListener("pixvault:history-forward", handleForwardRequest);
      window.removeEventListener("pixvault:history-branch", handleHistoryBranch);
    };
  }, [navigateBack, navigateForward]);

  const publishCatalogChange = useCallback(() => {
    invalidateMediaCatalogCache();
    setCatalogRefreshVersion((current) => current + 1);
  }, []);

  const refresh = useCallback(async (showOperation = true): Promise<string | undefined> => {
    const operation = showOperation
      ? startOperation({
          label: "ライブラリを更新",
          detail: "フォルダーと件数を確認しています",
          progress: null,
        })
      : undefined;
    setLoading(true);
    try {
      const [runtimeResult, rootResult, summaryResult] = await Promise.all([
        getRuntimeInfo(),
        listLibraryRoots(),
        getLibrarySummary(),
      ]);
      setRuntimeInfo(runtimeResult.data);
      setRoots(rootResult.data);
      setSummary(summaryResult.data);
      setNativeAvailable(runtimeResult.available && rootResult.available && summaryResult.available);
      const refreshError = messageFrom(
        runtimeResult.error,
        rootResult.error,
        summaryResult.error,
      );
      setError(refreshError);
      if (refreshError) operation?.fail(refreshError);
      else operation?.succeed(`${summaryResult.data.totalItems.toLocaleString("ja-JP")}件を確認しました`);
      return refreshError;
    } catch (caught) {
      const refreshError = operationErrorMessage(caught);
      setError(refreshError);
      operation?.fail(refreshError);
      return refreshError;
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSummary = useCallback(async () => {
    const [result, rootResult] = await Promise.all([getLibrarySummary(), listLibraryRoots()]);
    if (!rootResult.error) setRoots(rootResult.data);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSummary(result.data);
    setNativeAvailable((current) => current && result.available);
  }, []);

  const refreshPriorityScope = useCallback(() => {
    publishCatalogChange();
    void refreshSummary();
  }, [publishCatalogChange, refreshSummary]);

  const handleExternalMediaOpen = useCallback((batch: ExternalMediaOpenBatch) => {
    const target = externalExplorerTarget(batch);
    if (!target) {
      setError("ファイルの親フォルダーを確認できませんでした。");
      return;
    }
    setExplorerNavigationRequest(target.request);
    setExternalMediaBatch(batch);
    navigateToSection("allFolders");
    publishCatalogChange();
  }, [navigateToSection, publishCatalogChange]);

  const handleExternalMediaError = useCallback((message: string) => {
    setError(message);
    notifyApp({
      tone: "error",
      title: "ファイルを開けませんでした",
      message,
    });
  }, []);

  useExternalMediaOpen({
    enabled: true,
    onOpen: handleExternalMediaOpen,
    onError: handleExternalMediaError,
  });

  useEffect(() => {
    if (!nativeAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let refreshTimer: number | undefined;
    let pendingInserted = 0;
    void listen<{ inserted: number; updated: number; missing: number }>("library-watch-updated", (event) => {
      invalidateMediaCatalogCache();
      pendingInserted += event.payload.inserted;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        const inserted = pendingInserted;
        pendingInserted = 0;
        setCatalogRefreshVersion((current) => current + 1);
        if (inserted > 0) {
          notifyApp({
            tone: "success",
            title: "ライブラリを更新しました",
            message: `新しいメディアを${inserted.toLocaleString("ja-JP")}件追加しました。`,
          });
        }
        void Promise.all([getLibrarySummary(), listLibraryRoots()]).then(([summaryResult, rootsResult]) => {
          if (disposed) return;
          if (!summaryResult.error) setSummary(summaryResult.data);
          if (!rootsResult.error) setRoots(rootsResult.data);
        });
      }, 500);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      unlisten?.();
    };
  }, [nativeAvailable]);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    let draining = false;
    let drainAgain = false;
    const takePending = () => {
      if (draining) {
        drainAgain = true;
        return;
      }
      draining = true;
      void (async () => {
        try {
          do {
            drainAgain = false;
            let latestUrl: string | null = null;
            while (active) {
              const result = await takePendingXUrl();
              if (result.error || !result.data) break;
              latestUrl = result.data;
            }
            if (active && latestUrl) {
              setExternalMediaBatch(undefined);
              void refreshSummary();
              setExternalXUrl(latestUrl);
              setSection("downloads");
            }
          } while (active && drainAgain);
        } finally {
          draining = false;
          if (active && drainAgain) takePending();
        }
      })();
    };
    void listen<unknown>("pixvault://external-x-open", takePending)
      .then((stop) => {
        if (!active) stop();
        else {
          unlisten = stop;
          takePending();
        }
      })
      .catch(() => takePending());
    return () => {
      active = false;
      unlisten?.();
    };
  }, [nativeAvailable, refreshSummary]);

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if ([...(event.dataTransfer?.types ?? [])].some((type) =>
        type === "text/plain" || type === "text/uri-list")) {
        event.preventDefault();
      }
    };
    const onDrop = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (!transfer) return;
      const dropped = transfer.getData("text/uri-list") || transfer.getData("text/plain");
      const postUrl = extractXPostUrl(dropped);
      if (!postUrl) return;
      event.preventDefault();
      setExternalXUrl(postUrl);
      setSection("downloads");
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    // Visible favorites must not wait behind whole-library counts. This
    // effect runs before refresh; catalog revisions still revalidate it.
    if (section !== "home") return;
    let active = true;
    // Keep the previous shelf while revalidating counts/favorites instead of
    // briefly replacing every loaded image with the loading placeholder.
    void listMediaItems({
      favoritesOnly: true,
      sortBy: "modifiedAt",
      sortDirection: "desc",
      limit: 24,
    }).then((result) => {
      if (!active) return;
      setHomeFavoriteMedia(result.data);
      setHomeMediaLoading(false);
      if (result.error) setError((current) => current ?? result.error);
    });
    return () => { active = false; };
  }, [section, catalogRefreshVersion, summary.favorites]);

  const openHomeFolder = useCallback((folder: FolderActivityRecord) => {
    if (folder.navigationKey === "all") {
      const root = roots.find((entry) => entry.id === folder.rootId);
      if (!root) {
        setError("フォルダーの場所を確認できません。接続状態を確認して更新してください。");
        return;
      }
      setExternalMediaBatch(undefined);
      setExplorerNavigationRequest({ requestId: crypto.randomUUID(), path: joinFolderPath(root.path, folder.relativePath) });
      navigateToSection("allFolders");
      return;
    }
    rememberFolderNavigation(folder.navigationKey, {
      rootId: folder.rootId,
      path: folder.relativePath,
    });
    navigateToSection(folder.navigationKey === "images"
      ? "folders"
      : folder.navigationKey);
  }, [navigateToSection, roots]);

  const removeHomeFolderFavorite = useCallback((folder: FolderActivityRecord) => {
    void setFolderFavorite({
      rootId: folder.rootId,
      relativePath: folder.relativePath,
      displayName: folder.displayName,
      rootName: folder.rootName,
      itemCount: folder.itemCount,
      navigationKey: folder.navigationKey,
    }, false).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "お気に入りフォルダーを更新できませんでした。");
    });
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  async function addFolder() {
    const operation = startOperation({
      label: "優先フォルダーを追加",
      detail: "追加するフォルダーを選択しています",
      progress: null,
    });
    setError(undefined);
    setBusy(true);
    try {
      const picked = await pickLibraryRoot();
      if (picked.error) {
        setError(picked.error);
        operation.fail(picked.error);
        return;
      }
      if (!picked.data) {
        operation.cancel("フォルダーの追加をキャンセルしました");
        return;
      }

      operation.update({ detail: "優先フォルダーを設定しています" });
      const added = await addLibraryRoot(picked.data);
      if (!added.data || added.error) {
        const addError = added.error ?? "優先フォルダーを設定できませんでした。";
        setError(addError);
        operation.fail(addError);
        return;
      }

      publishCatalogChange();
      operation.update({
        label: `${added.data.displayName}を追加`,
        detail: "メディアを初回スキャンしています",
      });
      const scanResult = await scanLibrary(added.data.id);
      if (scanResult.available) publishCatalogChange();
      const refreshError = await refresh(false);
      const finalError = scanResult.error ?? refreshError;
      if (finalError) {
        setError(finalError);
        operation.fail(finalError);
      } else {
        operation.succeed(
          `${scanResult.data.totalItems.toLocaleString("ja-JP")}件をカタログへ反映しました`,
        );
      }
      navigateToSection("gallery");
    } catch (caught) {
      const addError = operationErrorMessage(caught);
      setError(addError);
      operation.fail(addError);
    } finally {
      setBusy(false);
    }
  }

  async function scan(rootId?: string) {
    const root = rootId ? roots.find((item) => item.id === rootId) : undefined;
    const operation = startOperation({
      label: root ? `${root.displayName}を再スキャン` : "すべてのフォルダーを再スキャン",
      detail: "追加・変更されたメディアを確認しています",
      progress: null,
    });
    setError(undefined);
    setBusy(true);
    try {
      const result = await scanLibrary(rootId);
      if (result.available) publishCatalogChange();
      const refreshError = await refresh(false);
      const finalError = result.error ?? refreshError;
      if (finalError) {
        setError(finalError);
        operation.fail(finalError);
      } else {
        operation.succeed(
          `${result.data.totalItems.toLocaleString("ja-JP")}件を確認しました`,
        );
      }
    } catch (caught) {
      const scanError = operationErrorMessage(caught);
      setError(scanError);
      operation.fail(scanError);
    } finally {
      setBusy(false);
    }
  }

  async function removeRoot(root: LibraryRoot) {
    if (!window.confirm(`「${root.displayName}」の優先指定を解除しますか？ ファイル・タグ・お気に入りは残ります。`)) return;
    const operation = startOperation({
      label: `${root.displayName}の優先指定を解除`,
      detail: "ライブラリ設定を更新しています",
      progress: null,
    });
    setError(undefined);
    setBusy(true);
    try {
      const result = await setFolderPriority(root.id, false);
      if (result.data && !result.error) publishCatalogChange();
      const refreshError = await refresh(false);
      const finalError =
        result.error ??
        (!result.data ? "フォルダーの優先指定を解除できませんでした。" : undefined) ??
        refreshError;
      if (finalError) {
        setError(finalError);
        operation.fail(finalError);
      } else {
        operation.succeed("優先指定を解除しました。ファイルは削除されていません");
      }
    } catch (caught) {
      const removeError = operationErrorMessage(caught);
      setError(removeError);
      operation.fail(removeError);
    } finally {
      setBusy(false);
    }
  }

  function home() {
    return (
      <div className="dashboard functional-dashboard">
        {error && <div className="operation-message error"><Icon name="warning" />{error}</div>}
        {!nativeAvailable && !loading && (
          <div className="operation-message warning"><Icon name="info" />
            ブラウザーのプレビューではフォルダーを操作できません。インストールしたPixVaultアプリから開いてください。
          </div>
        )}
        <div className="home-overview-grid">
          <section className="hero functional-hero">
            <div className="hero-content">
              <div className="hero-status"><span className="status-dot" />LOCAL · PRIVATE · READY</div>
              <p className="kicker">YOUR PERSONAL MEDIA SPACE</p>
              <h1>集める、見つける、<br /><em>また好きになる。</em></h1>
              <p className="hero-copy">
                PCに散らばる画像・動画・ブックを、元の場所はそのままに。PixVaultが一つの静かなワークスペースへまとめます。
              </p>
              <div className="hero-actions">
                <button className="primary-button" type="button" onClick={() => void addFolder()} disabled={busy || !nativeAvailable}>
                  <Icon name="folderPlus" />{busy ? "処理中…" : "優先フォルダーを追加"}
                </button>
                <button className="secondary-button" type="button" onClick={() => void scan()} disabled={busy || roots.length === 0}>
                  <Icon name="refresh" />ライブラリを同期
                </button>
              </div>
              <div className="hero-assurance">
                <span><Icon name="hardDrive" />ファイルはPC内に保持</span>
                <span><Icon name="check" />元のフォルダー構成を維持</span>
              </div>
            </div>
            <div className="hero-art" aria-hidden="true">
              <div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <div className="art-card card-back"><span /></div>
              <div className="art-card card-front"><div className="art-sun" /><div className="art-mountain mountain-one" /><div className="art-mountain mountain-two" /></div>
              <div className="hero-visual-badge"><Icon name="sparkles" /><span>いつもの場所から<br /><strong>すぐに見つかる</strong></span></div>
            </div>
          </section>

          <aside className="library-pulse" aria-label="ライブラリの概要">
            <header><span><p className="kicker">LIBRARY PULSE</p><h2>ライブラリ</h2></span><Icon name="database" /></header>
            <div className="pulse-total"><strong>{summary.totalItems.toLocaleString("ja-JP")}</strong><span>件のメディア</span></div>
            <div className="pulse-list">
              <button type="button" onClick={() => navigateToSection("folders")}><span><i className="pulse-dot image" />画像・GIF</span><strong>{(summary.images + summary.gifs).toLocaleString("ja-JP")}</strong></button>
              <button type="button" onClick={() => navigateToSection("videos")}><span><i className="pulse-dot video" />動画</span><strong>{summary.videos.toLocaleString("ja-JP")}</strong></button>
              <button type="button" onClick={() => navigateToSection("books")}><span><i className="pulse-dot book" />ブック</span><strong>{summary.books.toLocaleString("ja-JP")}</strong></button>
              <button type="button" onClick={() => navigateToSection("favorites")}><span><i className="pulse-dot favorite" />お気に入り</span><strong>{summary.favorites.toLocaleString("ja-JP")}</strong></button>
            </div>
            <footer><span><Icon name="hardDrive" /><small>使用容量</small><strong>{formatBytes(summary.storageBytes)}</strong></span><span><Icon name="folder" /><small>読み込み先</small><strong>{summary.libraryRoots} フォルダー</strong></span></footer>
          </aside>
        </div>

        <section className="quick-access-section" aria-labelledby="quick-access-title">
          <div className="section-heading"><div><p className="kicker">JUMP BACK IN</p><h2 id="quick-access-title">すぐに開く</h2></div><span className="section-note">優先フォルダー・メディア別の一覧</span></div>
          <div className="quick-access-grid">
            <button type="button" data-tone="violet" onClick={() => navigateToSection("gallery")}><span><Icon name="gallery" /></span><div><small>GALLERY</small><strong>ギャラリー</strong><em>優先フォルダーのみ</em></div><Icon name="arrowRight" /></button>
            <button type="button" data-tone="blue" onClick={() => navigateToSection("folders")}><span><Icon name="image" /></span><div><small>IMAGES</small><strong>画像</strong><em>{(summary.images + summary.gifs).toLocaleString("ja-JP")} 件</em></div><Icon name="arrowRight" /></button>
            <button type="button" data-tone="rose" onClick={() => navigateToSection("videos")}><span><Icon name="video" /></span><div><small>VIDEOS</small><strong>動画</strong><em>{summary.videos.toLocaleString("ja-JP")} 件</em></div><Icon name="arrowRight" /></button>
            <button type="button" data-tone="amber" onClick={() => navigateToSection("books")}><span><Icon name="book" /></span><div><small>BOOKS</small><strong>ブック</strong><em>{summary.books.toLocaleString("ja-JP")} 件</em></div><Icon name="arrowRight" /></button>
          </div>
        </section>

        <HomeShelves
          favoriteMedia={homeFavoriteMedia}
          mediaLoading={homeMediaLoading}
          roots={roots}
          onOpenMedia={setHomeSelectedMediaId}
          onOpenFolder={openHomeFolder}
          onRemoveFolderFavorite={removeHomeFolderFavorite}
        />

        <section className="root-panel home-roots-panel">
          <div className="section-heading"><div><p className="kicker">SOURCES</p><h2>メディアの保存場所</h2></div><button className="secondary-button" type="button" onClick={() => void addFolder()} disabled={busy || !nativeAvailable}><Icon name="folderPlus" />追加</button></div>
          {loading ? <p className="muted-copy">読み込み中…</p> : roots.length === 0 ? (
            <div className="empty-panel"><Icon name="folder" /><p>優先フォルダーを追加すると、ここから状態を確認できます。</p></div>
          ) : (
            <div className="root-list">
              {roots.map((root) => <article key={root.id}><Icon name="folder" /><div><strong>{root.displayName}</strong><span>{root.path}</span><small>{root.mediaCount.toLocaleString("ja-JP")} 件のメディア</small></div><button type="button" onClick={() => void scan(root.id)} disabled={busy}>同期</button></article>)}
            </div>
          )}
        </section>
        {homeSelectedMediaId && (
          <MediaViewer
            items={homeFavoriteMedia}
            currentId={homeSelectedMediaId}
            onClose={() => {
              setHomeSelectedMediaId(undefined);
              setHomeFavoriteMedia((current) => current.filter((item) => item.isFavorite));
            }}
            onItemPatch={(mediaId, patch) => {
              setHomeFavoriteMedia((current) => current.map((item) =>
                item.id === mediaId ? { ...item, ...patch } : item));
              void refreshSummary();
            }}
            onRemove={(mediaId) => {
              setHomeFavoriteMedia((current) => current.filter((item) => item.id !== mediaId));
              void refreshSummary();
            }}
            onCurrentIdChange={(mediaId) => setHomeSelectedMediaId(mediaId)}
          />
        )}
      </div>
    );
  }

  function settings() {
    const priorityRoots = roots.filter((root) => root.isPriority);
    return (
      <div className="dashboard functional-dashboard">
        {error && <div className="operation-message error"><Icon name="warning" />{error}</div>}
        <GeneralSettings nativeAvailable={nativeAvailable} />
        <DiagnosticSettings nativeAvailable={nativeAvailable} />
        <section className="settings-panel">
          <div className="section-heading"><div><p className="kicker">LIBRARY SETTINGS</p><h2>優先読み込みフォルダー</h2></div><button className="primary-button" type="button" onClick={() => void addFolder()} disabled={busy || !nativeAvailable}><Icon name="folderPlus" />追加</button></div>
          {priorityRoots.length === 0 ? <div className="empty-panel"><Icon name="folderWindows" /><p>優先フォルダーは配下を先に読み込みます。通常の閲覧は全フォルダーから利用できます。</p></div> : <div className="root-list settings-root-list">{priorityRoots.map((root) => <article key={root.id}><Icon name="folderWindows" /><div><strong>{root.displayName}</strong><span>{root.path}</span><small>{root.mediaCount} 件のメディア</small></div><button type="button" onClick={() => void scan(root.id)} disabled={busy}>再スキャン</button><button className="danger-button" type="button" onClick={() => void removeRoot(root)} disabled={busy}>優先指定を解除</button></article>)}</div>}
        </section>
        <section className="settings-panel">
          <div className="section-heading"><div><p className="kicker">X DOWNLOADER</p><h2>ダウンロード設定</h2></div></div>
          <XDownloadDirectorySetting />
        </section>
        <section className="settings-panel">
          <div className="section-heading">
            <div>
              <p className="kicker">BOOK VIEWER</p>
              <h2>ブック表示設定</h2>
            </div>
          </div>
          <BookViewerSettings />
        </section>
        <section className="settings-panel">
          <div className="section-heading">
            <div>
              <p className="kicker">VIDEO VIEWER</p>
              <h2>動画再生設定</h2>
            </div>
          </div>
          <VideoViewerSettings />
        </section>
        <section className="settings-panel">
          <div className="section-heading">
            <div>
              <p className="kicker">GALLERY</p>
              <h2>ギャラリー表示</h2>
            </div>
          </div>
          <GalleryDisplaySettings />
          <div className="section-heading search-grouping-settings-heading">
            <div>
              <p className="kicker">SEARCH HISTORY</p>
              <h2>検索履歴</h2>
            </div>
          </div>
          <SearchAndGroupingSettings />
          <div className="section-heading gallery-media-visibility-heading">
            <div>
              <p className="kicker">MEDIA TYPES</p>
              <h2>ギャラリーの表示メディア</h2>
            </div>
          </div>
          <GalleryMediaSettings />
        </section>
        <section className="settings-panel">
          <div className="section-heading">
            <div>
              <p className="kicker">MEDIA VIEWER</p>
              <h2>情報とレコメンドの表示</h2>
            </div>
          </div>
          <div className="viewer-layout-setting">
            <span className="viewer-layout-setting-icon"><Icon name="sparkles" /></span>
            <span>
              <strong>ビュワーの情報表示</strong>
              <small>画像・動画・ブックのタグ、詳細情報、おすすめを表示する位置です。</small>
            </span>
            <SelectMenu
              value={viewerInfoLayout}
              options={[
                { value: "sidebar", label: "右サイドバー", description: "右端へスナップ。閉じたまま下部へドラッグできます" },
                { value: "bottomSheet", label: "レコメンドボトムシート", description: "初期非表示。自由移動し、右端でサイドバーへ変形します" },
              ]}
              ariaLabel="ビュワーの情報表示"
              disabled={savingViewerInfoLayout}
              onChange={(value) => void changeViewerInfoLayout(value)}
            />
          </div>
          <ViewerControlSettings />
        </section>
        <section className="settings-panel">
          <div className="section-heading">
            <div>
              <p className="kicker">QUICK TOUR</p>
              <h2>チュートリアル</h2>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setBackgroundUiReady(true);
                setTutorialReopenRequestId((current) => current + 1);
              }}
            >
              <Icon name="play" />もう一度見る
            </button>
          </div>
          <p className="muted-copy">
            優先読み込み、ビュワー、AI分析、便利機能まで基本操作を6ステップで確認できます。
          </p>
        </section>
        <DataPortabilitySettings
          nativeAvailable={nativeAvailable}
          migrationFormatVersion={runtimeInfo?.migrationFormatVersion ?? 1}
          onDataChanged={() => {
            publishCatalogChange();
            void refresh();
          }}
        />
      </div>
    );
  }

  function about() {
    return (
      <div className="dashboard functional-dashboard info-dashboard">
        <section className="settings-panel about-panel">
          <p className="kicker">ABOUT PIXVAULT</p>
          <h1>{runtimeInfo?.os === "linux" ? "PixVault for Linux" : "PixVault for Windows"}</h1>
          <p>画像・GIF・動画・ブックを、元のフォルダー構成を保ったまま管理するデスクトップメディアライブラリです。</p>
          <div className="application-facts">
            <span><small>バージョン</small><strong>{runtimeInfo?.appVersion ?? "…"}</strong></span>
            <span><small>カタログ</small><strong>SQLite v{runtimeInfo?.databaseSchemaVersion ?? "…"}</strong></span>
            <span><small>実行環境</small><strong>{runtimeInfo ? `${runtimeInfo.os} · ${runtimeInfo.arch}` : "確認中…"}</strong></span>
          </div>
          <p className="muted-copy">メディアの削除はOSのごみ箱を使用し、優先指定の解除では元ファイルを削除しません。</p>
        </section>
      </div>
    );
  }

  function changelog() {
    return (
      <div className="dashboard functional-dashboard info-dashboard">
        <section className="settings-panel changelog-panel">
          <p className="kicker">RELEASE NOTES</p>
          <h1>更新履歴</h1>
          <p className="muted-copy">各バージョンを選ぶと、その版で追加・改善された内容を確認できます。</p>
          <ReleaseHistory />
        </section>
      </div>
    );
  }

  function content() {
    if (section === "home") return home();
    if (section === "gallery") return <MediaCollection refreshVersion={catalogRefreshVersion} eyebrow="GALLERY" title="ギャラリー" description="優先フォルダー配下のメディアだけを表示します。動画・ブックの表示は設定で変更できます。" kinds={galleryMediaKinds} priorityOnly compactFileLayout advancedGallerySearch viewerIncludesAllMedia tagNavigation={tagGalleryNavigation} emptyTitle="優先フォルダーのメディアはまだありません" emptyDescription="全フォルダーで優先読み込みに追加するか、優先フォルダーを指定してください。" onAddFolder={() => void addFolder()} onDataChanged={refreshSummary} />;
    if (section === "allFolders") return <FileSystemBrowser refreshVersion={catalogRefreshVersion} onDataChanged={refreshSummary} onPriorityChanged={refreshPriorityScope}
      navigationRequest={explorerNavigationRequest}
      openRequest={externalTarget ? { requestId: externalTarget.request.requestId, item: externalTarget.item } : undefined}
      onOpenRequestClose={() => { setExternalMediaBatch(undefined); setExplorerNavigationRequest(undefined); void refreshSummary(); }} />;
    if (section === "folders") return <FolderMediaCollection refreshVersion={catalogRefreshVersion} navigationKey="images" eyebrow="IMAGES" title="画像" description="画像とGIFだけを、元のフォルダー構成ごとに表示します。" kinds={IMAGE_MEDIA_KINDS} emptyTitle="画像フォルダーはまだありません" emptyDescription="全フォルダーから画像やGIFのある場所を開いてください。" onAddFolder={() => void addFolder()} onDataChanged={refreshSummary} />;
    if (section === "videos") return <FolderMediaCollection refreshVersion={catalogRefreshVersion} navigationKey="videos" eyebrow="VIDEOS" title="動画" description="動画をフォルダー単位で整理して表示します。" kinds={VIDEO_MEDIA_KINDS} emptyTitle="動画はまだありません" emptyDescription="全フォルダーから開くか、優先フォルダーを指定してください。" onAddFolder={() => void addFolder()} onDataChanged={refreshSummary} />;
    if (section === "books") return <FolderMediaCollection refreshVersion={catalogRefreshVersion} navigationKey="books" eyebrow="BOOKS" title="ブック" description="PDFとZIP/CBZをフォルダー単位で整理して表示します。" kinds={BOOK_MEDIA_KINDS} emptyTitle="ブックはまだありません" emptyDescription="全フォルダーから開くか、優先フォルダーを指定してください。" onAddFolder={() => void addFolder()} onDataChanged={refreshSummary} />;
    if (section === "favorites") return <MediaCollection refreshVersion={catalogRefreshVersion} eyebrow="FAVORITES" title="お気に入り" description="星を付けたメディアを、形式で絞り込んで表示します。" compactFileLayout favoritesOnly showFavoriteKindFilter emptyTitle="お気に入りはまだありません" emptyDescription="メディアカードの星ボタンで追加できます。" onAddFolder={() => void addFolder()} onDataChanged={refreshSummary} />;
    if (section === "sites") return <FavoriteSitesPage />;
    if (section === "creators") return <FavoriteCreatorsPage />;
    if (section === "references") return <DrawingReferencesPage />;
    if (section === "downloads") return (
      <XDownloaderPage
        initialUrl={externalXUrl}
        onInitialUrlConsumed={() => setExternalXUrl(undefined)}
      />
    );
    if (section === "about") return about();
    if (section === "changelog") return changelog();
    return settings();
  }

  return (
    <div className={`app-shell${sidebarMinimized ? " sidebar-minimized" : ""}${mobileNavigationOpen ? " mobile-navigation-open" : ""}`}>
      <a className="skip-link" href="#main-content">メインコンテンツへ移動</a>
      <aside className="sidebar" id="app-navigation" aria-label="PixVault ナビゲーション">
        <div className="sidebar-brand-row">
          <div className="brand">
            <div className="brand-mark"><span /><span /><span /></div>
            <div><strong>PixVault</strong><small>{runtimeInfo?.os === "linux" ? "for Linux" : "for Windows"}</small></div>
          </div>
          <button className="mobile-navigation-close" type="button" aria-label="メニューを閉じる" onClick={() => setMobileNavigationOpen(false)}><Icon name="close" /></button>
        </div>
        <button
          className="sidebar-collapse-button"
          type="button"
          aria-label={sidebarMinimized ? "サイドバーを展開" : "サイドバーを最小表示"}
          title={sidebarMinimized ? "サイドバーを展開" : "サイドバーを最小表示"}
          onClick={() => {
            const next = !sidebarMinimized;
            setSidebarMinimized(next);
            void setJsonPreference("sidebarMinimized", next);
          }}
        >
          <Icon name="chevronRight" />
        </button>
        <div className="sidebar-library-summary">
          <span><Icon name="database" /></span>
          <div><small>MY LIBRARY</small><strong>{summary.totalItems.toLocaleString("ja-JP")} items</strong></div>
        </div>
        <nav aria-label="メインナビゲーション">
          {navigationGroups.map((group, groupIndex) => (
            <div className="nav-group" key={group.label ?? `primary-${groupIndex}`}>
              {group.label && <span className="nav-section-label">{group.label}</span>}
              {group.items.map((item) => (
                <button className={section === item.id ? "nav-item active" : "nav-item"} key={item.id} onClick={() => navigateToSection(item.id)} type="button" title={item.label} aria-current={section === item.id ? "page" : undefined}>
                  <Icon name={item.icon} /><span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={nativeAvailable ? "status-dot" : "status-dot is-offline"} />
          <div><strong>{nativeAvailable ? "ライブラリ接続中" : "プレビュー表示"}</strong><small>v{runtimeInfo?.appVersion ?? "…"}</small></div>
        </div>
      </aside>
      <button className="mobile-navigation-backdrop" type="button" aria-label="メニューを閉じる" onClick={() => setMobileNavigationOpen(false)} />
      <main className="main-panel" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="topbar-leading">
            <button className="icon-button mobile-menu-button" type="button" aria-label="メニューを開く" aria-controls="app-navigation" aria-expanded={mobileNavigationOpen} onClick={() => setMobileNavigationOpen(true)}><Icon name="menu" /></button>
            <div className="history-actions" aria-label="履歴ナビゲーション">
              <button className="icon-button" type="button" aria-label="前の画面へ戻る" title="戻る" onClick={navigateBack}><Icon name="chevronRight" /></button>
              <button className="icon-button" type="button" aria-label="次の画面へ進む" title="進む" onClick={navigateForward}><Icon name="chevronRight" /></button>
            </div>
            <div className="page-identity"><span>{activeDetails.eyebrow}</span><div><strong>{activeLabel}</strong><small>{activeDetails.description}</small></div></div>
          </div>
          <div className="topbar-actions">
            <button className="topbar-add-button" type="button" onClick={() => void addFolder()} disabled={busy || !nativeAvailable}><Icon name="folderPlus" /><span>優先フォルダーを追加</span></button>
            <NotificationCenter />
            <button className="icon-button" type="button" aria-label="すべてのフォルダーを再スキャン" title="すべてのフォルダーを再スキャン" onClick={() => void scan()} disabled={loading || busy || !nativeAvailable || roots.length === 0}><Icon name="refresh" className={busy ? "rotating" : undefined} /></button>
          </div>
        </header>
        <Suspense fallback={<div className="empty-panel"><span className="spinner" /><p>読み込み中…</p></div>}>
          {content()}
        </Suspense>
      </main>
      <OperationTray />
      {aiAnalysisPanelRequest && !externalMediaBatch && (
        <Suspense fallback={null}>
          <AIAnalysisModal
            key={aiAnalysisPanelRequest.requestId}
            open
            selectedItems={[]}
            initialRootId={aiAnalysisPanelRequest.rootId}
            initialFolderPath={aiAnalysisPanelRequest.folderPath}
            currentFolderOnly={aiAnalysisPanelRequest.currentFolderOnly}
            floating
            onClose={() => setAiAnalysisPanelRequest(undefined)}
          />
        </Suspense>
      )}
      {(backgroundUiReady || aiAnalysisPanelRequest) && (
        <Suspense fallback={null}>
          <AiAnalysisMonitor hidden={Boolean(aiAnalysisPanelRequest)} />
          {backgroundUiReady && !externalMediaBatch && (
            <FirstRunTutorial reopenRequestId={tutorialReopenRequestId} />
          )}
        </Suspense>
      )}
    </div>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** index;
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

export default App;
