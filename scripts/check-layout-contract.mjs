import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(resolve(projectRoot, "src/App.tsx"), "utf8");
const appCss = readFileSync(resolve(projectRoot, "src/App.css"), "utf8");
const shelvesCss = readFileSync(resolve(projectRoot, "src/components/HomeShelves.css"), "utf8");
const mediaCollection = readFileSync(resolve(projectRoot, "src/components/MediaCollection.tsx"), "utf8");
const mediaViewer = readFileSync(resolve(projectRoot, "src/components/MediaViewer.tsx"), "utf8");
const bookViewerSettings = readFileSync(resolve(projectRoot, "src/components/BookViewerSettings.tsx"), "utf8");
const viewerCss = readFileSync(resolve(projectRoot, "src/components/MediaViewer.css"), "utf8");
const displaySettings = readFileSync(resolve(projectRoot, "src/components/GalleryDisplaySettings.tsx"), "utf8");
const displayPreferences = readFileSync(resolve(projectRoot, "src/services/galleryDisplayPreferences.ts"), "utf8");
const folderActivity = readFileSync(resolve(projectRoot, "src/services/folderActivity.ts"), "utf8");
const database = readFileSync(resolve(projectRoot, "src-tauri/src/db.rs"), "utf8");
const filenameOrder = readFileSync(resolve(projectRoot, "src-tauri/src/filename_order.rs"), "utf8");
const catalog = readFileSync(resolve(projectRoot, "src-tauri/src/catalog.rs"), "utf8");
const filesystemBrowser = readFileSync(resolve(projectRoot, "src/components/FileSystemBrowser.tsx"), "utf8");

const contracts = [
  [app.includes('href="#main-content"'), "skip link targets the main content"],
  [app.includes('id="main-content"'), "main content landmark has a stable target"],
  [app.includes('aria-current={section === item.id ? "page" : undefined}'), "active navigation exposes aria-current"],
  [app.includes('aria-controls="app-navigation"'), "mobile menu controls the navigation drawer"],
  [app.includes('className="mobile-navigation-backdrop"'), "mobile drawer has a dismiss backdrop"],
  [app.includes('className="home-overview-grid"'), "home uses the workspace overview grid"],
  [app.includes('className="quick-access-grid"'), "home exposes format shortcuts"],
  [appCss.includes("@media (max-width: 900px)"), "drawer breakpoint is present"],
  [appCss.includes("@media (max-width: 680px)"), "small-screen layout breakpoint is present"],
  [shelvesCss.includes(".home-shelf-section:first-child { grid-column: 1 / -1; }"), "home shelves use the bento hierarchy"],
  [!mediaCollection.includes('from "./AdjacentSimilarityGroups"'), "adjacent-similarity section is not mounted"],
  [!mediaCollection.includes('from "./FolderGroupsPanel"'), "virtual folder groups are not mounted in the image browser"],
  [mediaCollection.includes('className="favorite-folders-panel"'), "image browser exposes favorite folders"],
  [mediaCollection.includes("displayPreferences.groupMode") && mediaCollection.includes("!showMediaVisibilityMenu") && mediaCollection.includes("galleryGroupOptions.map"), "gallery grouping is removed from the top toolbar and retained in the context menu"],
  [displayPreferences.includes('groupMode: "none"') && displaySettings.includes("更新日単位の見出し"), "gallery grouping is opt-in and configurable by day, month, or year"],
  [!app.includes('id: "folders"') && !app.includes('id: "videos"') && !app.includes('id: "books"'), "separate image, video, and book navigation pages are removed"],
  [app.indexOf('id: "gallery"') < app.indexOf('id: "allFolders"') && app.indexOf('id: "allFolders"') < app.indexOf('id: "favorites"'), "all-media folder navigation sits between gallery and favorites"],
  [app.includes("<FileSystemBrowser"), "all-folder navigation uses the on-demand filesystem browser"],
  [/section === "gallery"[^;]*kinds=\{galleryMediaKinds\}[^;]*\bcompactFileLayout\b/.test(app), "main gallery uses the same compact layout as folder media galleries"],
  [mediaCollection.includes("showMediaVisibilityMenu") && mediaCollection.includes('role="menuitemcheckbox"'), "gallery context menu selects visible media formats"],
  [displayPreferences.includes('"extra-large-icons"') && displayPreferences.includes('"details"') && mediaCollection.includes("galleryViewOptions.map"), "gallery context menu exposes Explorer-style view modes"],
  [mediaCollection.includes('name="folderWindows"') && appCss.includes(".folder-windows-front"), "folder browsers use an Explorer-style two-tone folder icon"],
  [mediaCollection.includes('"--gallery-visual-size"') && appCss.includes("aspect-ratio: 1"), "gallery thumbnails use a square visual frame"],
  [mediaCollection.includes("targetCardWidth = galleryCompactCardWidths[size]") && displayPreferences.includes("medium: 112") && mediaCollection.includes("rowHeight: squareSize + VIRTUAL_GAP") && appCss.includes(".compact-file-layout .virtual-media-card.is-compact-file") && appCss.includes("aspect-ratio: 1;"), "gallery tiles honor density and remain square including thumbnail and text"],
  [mediaViewer.includes("waitForBookCacheIdle") && mediaViewer.includes("BOOK_PAGE_CACHE_LOOK_AHEAD"), "book viewer preloads a bounded page window while idle"],
  [mediaViewer.includes("<figure key={slot}>") && !mediaViewer.includes("const renderTasks: RenderTask[]"), "book paging preserves the current canvas while the next page is prepared"],
  [bookViewerSettings.includes('binding: "right"') && mediaViewer.includes('return binding === "right" ? pages.reverse() : pages'), "book spreads default to page 2 on the left and page 1 on the right"],
  [viewerCss.includes("width: calc(100vw - 16px)") && viewerCss.includes("height: calc(100dvh - 16px)"), "viewer scales with the application window"],
  [mediaViewer.includes("useState(false)") && mediaViewer.includes('className={`pv-viewer-rail placement-${placement}'), "viewer list and recommendations start hidden"],
  [mediaViewer.includes('value: "top"') && mediaViewer.includes('value: "bottom"') && mediaViewer.includes('value: "left"') && mediaViewer.includes('value: "right"') && mediaViewer.includes('value: "floating"'), "viewer panels support all five placements"],
  [viewerCss.includes(".pv-viewer-rail.is-collapsed") && viewerCss.includes("border-radius: 50%") && viewerCss.includes(".pv-media-info-panel.is-collapsed"), "minimized floating viewer panels use round icons"],
  [viewerCss.includes(".is-collapsed:not(.placement-floating)") && viewerCss.includes("width: 190px") && viewerCss.includes("height: 150px"), "docked minimized panels retain edge-tab shapes"],
  [viewerCss.includes('content: "○ 上へ移動"') && viewerCss.includes('content: "○ フローティングへ移動"'), "both movable panels expose a translucent destination preview"],
  [mediaViewer.includes('className="pv-viewer-title-zoom"') && mediaViewer.includes("showEntireImage") && !mediaViewer.includes('className="pv-image-zoom-controls"'), "image zoom and whole-image fit controls live in the viewer title tab"],
  [mediaViewer.includes('label="すべての枠を非表示（Escで戻す）"') && mediaViewer.includes("!isFullscreen"), "viewer chrome can be hidden beside fullscreen and the button disappears in fullscreen"],
  [mediaCollection.includes("mediaKindIcon") && !mediaCollection.includes('item.kind.toUpperCase()') && !mediaCollection.includes('item.ageRating === "UNRATED" ? "未選択"'), "gallery uses color-coded media icons without UNRATED or ARCHIVE labels"],
  [appCss.includes(".view-mode-details) .virtual-media-card.is-compact-file .media-card-actions") && appCss.includes("opacity: 1"), "list and details views keep favorite and delete actions visible"],
  [filesystemBrowser.includes('forcedSortOrder="name-asc"') && filenameOrder.includes("StrCmpLogicalW") && database.includes('"[a]"') && database.includes('"1.webp"'), "direct Explorer folders and viewer collections use Windows logical name order"],
  [catalog.includes("sync_parent_folder_tag") && catalog.includes("source = 'folder'") && catalog.includes('matches!(media_kind, "video" | "pdf" | "zip")'), "books and videos keep one managed current-parent-folder tag"],
];

const failures = contracts.filter(([passed]) => !passed);
for (const [passed, description] of contracts) {
  console.log(`${passed ? "PASS" : "FAIL"} ${description}`);
}
if (failures.length > 0) process.exitCode = 1;
