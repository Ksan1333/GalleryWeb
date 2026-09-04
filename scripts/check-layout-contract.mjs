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
const folderActivity = readFileSync(resolve(projectRoot, "src/services/folderActivity.ts"), "utf8");

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
  [mediaCollection.includes("displayPreferences.groupMode") && mediaCollection.includes('label="グループ化"') && mediaCollection.includes("galleryGroupOptions.map"), "gallery grouping is available from the toolbar and context menu"],
  [displaySettings.includes('groupMode: "none"') && displaySettings.includes("更新日単位の見出し"), "gallery grouping is opt-in and configurable by day, month, or year"],
  [mediaCollection.includes('navigationKey === "images" || navigationKey === "videos" || navigationKey === "books"'), "image, video, and book folders use compact media tiles"],
  [app.indexOf('id: "gallery"') < app.indexOf('id: "allFolders"') && app.indexOf('id: "allFolders"') < app.indexOf('id: "favorites"'), "all-media folder navigation sits between gallery and favorites"],
  [app.includes("<FileSystemBrowser") && folderActivity.includes('"all" | "images"'), "all-folder navigation uses the on-demand filesystem browser"],
  [/section === "gallery"[^;]*kinds=\{galleryMediaKinds\}[^;]*\bcompactFileLayout\b/.test(app), "main gallery uses the same compact layout as folder media galleries"],
  [appCss.includes(".compact-file-gallery .root-folder-card"), "image, video, and book root folders use compact rows"],
  [mediaCollection.includes('name="folderWindows"') && appCss.includes(".folder-windows-front"), "folder browsers use an Explorer-style two-tone folder icon"],
  [mediaCollection.includes('"--gallery-visual-size"') && appCss.includes("aspect-ratio: 1"), "gallery thumbnails use a square visual frame"],
  [mediaCollection.includes("targetCardWidth = 112") && mediaCollection.includes("rowHeight: squareSize + VIRTUAL_GAP") && appCss.includes(".compact-file-layout .virtual-media-card.is-compact-file") && appCss.includes("aspect-ratio: 1;"), "gallery tiles remain square including thumbnail and text"],
  [mediaViewer.includes("waitForBookCacheIdle") && mediaViewer.includes("BOOK_PAGE_CACHE_LOOK_AHEAD"), "book viewer preloads a bounded page window while idle"],
  [mediaViewer.includes("<figure key={slot}>") && !mediaViewer.includes("const renderTasks: RenderTask[]"), "book paging preserves the current canvas while the next page is prepared"],
  [bookViewerSettings.includes('binding: "right"') && mediaViewer.includes('return binding === "right" ? pages.reverse() : pages'), "book spreads default to page 2 on the left and page 1 on the right"],
  [viewerCss.includes("width: calc(100vw - 16px)") && viewerCss.includes("height: calc(100dvh - 16px)"), "viewer scales with the application window"],
];

const failures = contracts.filter(([passed]) => !passed);
for (const [passed, description] of contracts) {
  console.log(`${passed ? "PASS" : "FAIL"} ${description}`);
}
if (failures.length > 0) process.exitCode = 1;
