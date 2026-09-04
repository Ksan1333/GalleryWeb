// Isolated headless React/DOM performance regression test. No desktop, screenshots,
// real catalog, user files, network media, or native commands are accessed.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-startup-performance.mjs
// Add --baseline-0.2.1 for a non-gating measurement of the released source.
// Counts/order are regression gates; development-mode timing is diagnostic only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.argv.includes("--baseline-0.2.1");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const baselineSources = new Map();
// Unchanged tracked source already is the baseline; avoid spawning git for every
// Vite module (which would distort startup and contend with concurrent builds).
const trackedSources = baseline ? new Set(execFileSync("git", ["diff", "--name-only", "--diff-filter=M", "0.2.1", "--", "src"],
  { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/)) : new Set();
const server = await createServer({
  root, configFile: false, logLevel: "error",
  plugins: [{
    name: "startup-performance-instrumentation", enforce: "pre",
    transform(code, id) {
      const file = relative(root, id.split("?")[0]).replaceAll("\\", "/");
      if (baseline && trackedSources.has(file)) {
        if (!baselineSources.has(file)) baselineSources.set(file,
          execFileSync("git", ["show", `0.2.1:${file}`], { cwd: root, encoding: "utf8" }));
        code = baselineSources.get(file);
      }
      if (file === "src/components/MediaCollection.tsx") {
        const pattern = /(const MediaCard = memo\(function MediaCard\([\s\S]*?\}\) \{)/;
        assert.match(code, pattern, "instrumentation must count the actual memoized MediaCard");
        code = code.replace(pattern, "$1\nwindow.__startupFixture.cardRenders += 1; window.__startupFixture.rendersById[item.id] = (window.__startupFixture.rendersById[item.id] ?? 0) + 1;");
      }
      return code;
    },
  }, react(), {
    name: "startup-performance-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__startup_test", (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><div id="root"></div>
          <script type="module">
            import RefreshRuntime from '/@react-refresh';
            RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
            window.__vite_plugin_react_preamble_installed__ = true;
          </script>
          <script type="module" src="/@vite/client"></script>
          <script type="module">
            import React from '/node_modules/.vite/deps/react.js';
            import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
            import App from '/src/App.tsx';
            import {MediaCollection} from '/src/components/MediaCollection.tsx';
            import '/src/App.css';
            const gallery = new URLSearchParams(location.search).get('view') === 'gallery';
            const tree = gallery ? React.createElement('div', {className: 'app-shell'},
              React.createElement('main', {className: 'main-panel'},
                React.createElement('header', {className: 'topbar'}, 'Performance fixture'),
                React.createElement(MediaCollection, {
                  eyebrow: 'GALLERY', title: 'Gallery fixture', description: 'Synthetic catalog',
                  kinds: ['image'], compactFileLayout: true, advancedGallerySearch: true,
                  emptyTitle: 'Empty', emptyDescription: 'Empty fixture', onDataChanged: () => {},
                }))) : React.createElement(App);
            window.__startupFixture.renderStarted = performance.now();
            ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.Profiler, {
              id: 'fixture', onRender: (_id, phase, actualDuration) => {
                window.__startupFixture.commits.push({phase, actualDuration, at: performance.now()});
              },
            }, tree));
          </script></body></html>`);
      });
    },
  }],
  optimizeDeps: { entries: ["src/App.tsx", "src/components/MediaCollection.tsx"], include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/src-tauri/**", "**/release/**"] } },
});

function installNativeFixture() {
  const stats = window.__startupFixture = {
    calls: [], thumbnailIds: [], cardRenders: 0, rendersById: {}, commits: [], longTasks: [],
    activeThumbnailItems: 0, maxThumbnailItems: 0, summaryCompleted: null,
    firstHomeCard: null, renderStarted: null, unexpected: [],
    holdAdditionalPages: false, pendingPageQueries: 0,
  };
  const pendingPages = [];
  window.__releaseFixturePages = () => {
    stats.holdAdditionalPages = false;
    pendingPages.splice(0).forEach((resolve) => resolve());
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const callbacks = new Map();
  let callbackId = 0;
  const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#b892ec"/></svg>');
  const makeItem = (id) => ({
    id, rootId: "fixture-root", relativePath: `${id}.jpg`, path: image, name: `${id}.jpg`,
    kind: "image", mimeType: "image/jpeg", width: 144, height: 144, sizeBytes: 1234,
    modifiedAt: "2026-08-20T12:00:00Z", importedAt: "2026-08-20T12:00:00Z",
    isFavorite: id.startsWith("favorite-"), ageRating: "SFW", tags: [],
  });
  const preferences = {
    "onboarding.firstRun.v1": { status: "completed", step: 5 },
    folderActivity: Array.from({ length: 24 }, (_, index) => ({
      rootId: "fixture-root", relativePath: `folder-${index}`, displayName: `Folder ${index}`,
      rootName: "Fixture", itemCount: 100, navigationKey: "images", visits: 24 - index,
      lastVisitedAt: "2026-08-20T12:00:00Z", isFavorite: true,
    })),
  };
  const observed = new MutationObserver(() => {
    if (stats.firstHomeCard === null && document.querySelector(".home-media-card")) {
      stats.firstHomeCard = performance.now();
    }
  });
  observed.observe(document, { childList: true, subtree: true });
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver((list) => stats.longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration }))))
      .observe({ type: "longtask", buffered: true });
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc() { return image; },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: async (command, args = {}) => {
      stats.calls.push({ command, args, at: performance.now() });
      if (command === "plugin:event|listen") return args.handler;
      if (command === "plugin:event|unlisten") return null;
      if (command === "plugin:window|set_theme") return null;
      if (command === "get_preferences") { await sleep(15); return preferences; }
      if (command === "get_runtime_info") {
        await sleep(20);
        return { appName: "Fixture", appVersion: "0.2.1", os: "windows", arch: "x86_64", databaseSchemaVersion: 1 };
      }
      if (command === "list_library_roots") {
        await sleep(30);
        return [{ id: "fixture-root", path: "X:\\SyntheticOnly", displayName: "Fixture", mediaCount: 220000, isPriority: true }];
      }
      if (command === "get_library_summary") {
        await sleep(900); // Deliberately slow aggregate; preview must not depend on it.
        stats.summaryCompleted = performance.now();
        return { totalItems: 220000, images: 220000, gifs: 0, videos: 0, books: 0, documents: 0,
          favorites: 24, tags: 0, libraryRoots: 1, storageBytes: 220000 * 1234 };
      }
      if (command === "list_media_items") {
        await sleep(25);
        const query = args.query ?? {};
        const count = query.favoriteOnly ? 24 : query.folderPath !== undefined ? 1 : 220000;
        const offset = query.offset ?? 0;
        if (stats.holdAdditionalPages && offset > 0) {
          stats.pendingPageQueries += 1;
          await new Promise((resolve) => pendingPages.push(resolve));
        }
        return Array.from({ length: Math.min(query.limit ?? 240, Math.max(0, count - offset)) }, (_, i) =>
          makeItem(query.favoriteOnly ? `favorite-${i + offset}` : query.folderPath !== undefined ? `folder-preview-${query.folderPath}` : `media-${i + offset}`));
      }
      if (command === "get_media_page_info") {
        await sleep(60);
        return { totalCount: 220000, dateGroups: [] };
      }
      if (command === "get_media_thumbnails" || command === "get_media_thumbnail") {
        const ids = command === "get_media_thumbnails" ? args.mediaIds : [args.mediaId];
        stats.thumbnailIds.push(...ids);
        stats.activeThumbnailItems += ids.length;
        stats.maxThumbnailItems = Math.max(stats.maxThumbnailItems, stats.activeThumbnailItems);
        await sleep(45);
        stats.activeThumbnailItems -= ids.length;
        return command === "get_media_thumbnails" ? ids.map((mediaId) => ({ mediaId, thumbnailPath: image })) : image;
      }
      if (command === "get_ai_analysis_status") return { phase: "idle", categoryCounts: [], previewTags: [], cleanupPending: false };
      if (command === "get_thumbnail_precache_status" || command === "take_pending_x_url") return null;
      if (command === "list_media_folders" || command === "list_tags") return [];
      if (command === "list_tag_translations") return {};
      stats.unexpected.push(command);
      throw new Error(`Unexpected native command in isolated fixture: ${command}`);
    },
  };
}

async function quiet(page) {
  await page.waitForFunction(() => {
    const stats = window.__startupFixture;
    return stats.calls.length > 0 && stats.activeThumbnailItems === 0
      && performance.now() - stats.calls.at(-1).at > 220;
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const address = server.httpServer.address();
  const metrics = { source: baseline ? "0.2.1" : "working-tree", syntheticCatalogItems: 220000 };
  for (const view of ["home", "gallery"]) {
    console.log(`Measuring ${view} (${baseline ? "0.2.1" : "working tree"})`);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
    // Reject any unexpected external request; all test media is an inline SVG.
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue() : route.abort());
    await page.addInitScript(installNativeFixture);
    await page.goto(`http://127.0.0.1:${address.port}/__startup_test?view=${view}`, { timeout: 60000 });
    if (view === "home") {
      await page.waitForFunction(() => window.__startupFixture.summaryCompleted !== null && document.querySelectorAll(".home-media-card").length === 24)
        .catch(async (error) => { console.error(await page.evaluate(() => ({ stats: window.__startupFixture, text: document.body.innerText.slice(0, 2000) }))); throw error; });
      await quiet(page);
      const home = await page.evaluate(() => {
        const stats = window.__startupFixture;
        const favoriteCalls = stats.calls.filter(({ command, args }) => command === "list_media_items" && args.query.favoriteOnly);
        return {
          favoritesQueries: favoriteCalls.length,
          favoriteQueryBeforeSummary: favoriteCalls[0].at < stats.summaryCompleted,
          firstCardBeforeSummary: stats.firstHomeCard < stats.summaryCompleted,
          favoriteThumbnailsInitiallyRequested: new Set(stats.thumbnailIds.filter((id) => id.startsWith("favorite-"))).size,
          folderPreviewQueries: stats.calls.filter(({ command, args }) => command === "list_media_items" && args.query.folderPath !== undefined).length,
          firstCardAfterRenderMs: Math.round(stats.firstHomeCard - stats.renderStarted),
          maxThumbnailItems: stats.maxThumbnailItems,
          overviewCalls: Object.fromEntries(["get_preferences", "get_runtime_info", "get_library_summary", "list_library_roots"].map((name) => [name, stats.calls.filter(({ command }) => command === name).length])),
        };
      });
      // The shelves can be below the first viewport. Reveal the favorite shelf
      // before testing horizontal admission (initial counts above stay intact).
      await page.evaluate(() => document.querySelector(".home-shelf-section").scrollIntoView({ block: "center" }));
      await page.waitForFunction(() => {
        const first = document.querySelector(".home-horizontal-shelf .home-media-card:first-child img");
        return first?.complete && first.naturalWidth > 0;
      });
      await quiet(page);
      home.favoriteThumbnailsAfterReveal = await page.evaluate(() => new Set(window.__startupFixture.thumbnailIds.filter((id) => id.startsWith("favorite-"))).size);
      await page.evaluate(() => {
        const shelf = document.querySelector(".home-horizontal-shelf");
        shelf.scrollLeft = shelf.scrollWidth;
      });
      await page.waitForFunction(() => {
        const last = document.querySelector(".home-horizontal-shelf .home-media-card:last-child img");
        return last?.complete && last.naturalWidth > 0;
      });
      await quiet(page);
      home.favoriteThumbnailsAfterScroll = await page.evaluate(() => new Set(window.__startupFixture.thumbnailIds.filter((id) => id.startsWith("favorite-"))).size);
      await page.evaluate(() => document.querySelectorAll(".home-shelf-section")[1].scrollIntoView({ block: "center" }));
      await page.waitForFunction(() => window.__startupFixture.calls.some(({ command, args }) => command === "list_media_items" && args.query.folderPath !== undefined));
      await quiet(page);
      home.folderPreviewQueriesAfterVerticalScroll = await page.evaluate(() => window.__startupFixture.calls.filter(({ command, args }) => command === "list_media_items" && args.query.folderPath !== undefined).length);
      home.maxThumbnailItems = await page.evaluate(() => window.__startupFixture.maxThumbnailItems);
      assert.ok(home.folderPreviewQueriesAfterVerticalScroll > 0 && home.folderPreviewQueriesAfterVerticalScroll < 24,
        "folder shelves request only their intersecting previews, not all 24 folders");
      assert.ok(home.maxThumbnailItems <= 16, "home native thumbnail work is bounded");
      assert.ok(Object.values(home.overviewCalls).every((count) => count === 1), "startup overview calls are deduplicated");
      if (!baseline) {
        assert.equal(home.favoritesQueries, 1, "slow summary completion must not refetch the same favorites page");
        assert.ok(home.favoriteQueryBeforeSummary && home.firstCardBeforeSummary, "home preview must not wait for full-library aggregation");
        assert.ok(home.favoriteThumbnailsInitiallyRequested < 24, "offscreen favorites must not occupy native thumbnail slots at startup");
        assert.ok(home.favoriteThumbnailsAfterReveal > 0 && home.favoriteThumbnailsAfterReveal < 24,
          "revealing the shelf requests visible favorites, not every horizontal item");
        assert.ok(home.favoriteThumbnailsAfterScroll > home.favoriteThumbnailsAfterReveal, "horizontal scrolling requests previously hidden thumbnails");
      }
      metrics.home = home;
    } else {
      await page.waitForFunction(() => document.querySelector(".result-meta")?.textContent.includes("220,000"));
      await quiet(page);
      const before = await page.evaluate(() => ({
        renders: window.__startupFixture.cardRenders,
        queries: window.__startupFixture.calls.filter(({ command }) => command === "list_media_items").length,
        cards: document.querySelectorAll(".media-card").length,
      }));
      // Native DOM scroll in an isolated headless fixture, not desktop input.
      await page.evaluate(async () => {
        const scroller = document.querySelector(".virtual-media-scroller");
        for (let i = 1; i <= 30; i += 1) {
          scroller.scrollTop = i * 2;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      });
      await quiet(page);
      const gallery = await page.evaluate((before) => ({
        mountedCards: document.querySelectorAll(".media-card").length,
        cardRendersDuring30SmallScrolls: window.__startupFixture.cardRenders - before.renders,
        additionalPageQueriesDuringSmallScrolls: window.__startupFixture.calls.filter(({ command }) => command === "list_media_items").length - before.queries,
        maxThumbnailItems: window.__startupFixture.maxThumbnailItems,
        initialPageQueries: before.queries,
        totalThumbnailLookups: window.__startupFixture.thumbnailIds.length,
      }), before);
      assert.ok(gallery.mountedCards > 0 && gallery.mountedCards < 300, "220,000 media remain viewport-virtualized");
      assert.ok(gallery.maxThumbnailItems <= 16, "gallery native thumbnail work is bounded");
      assert.equal(gallery.additionalPageQueriesDuringSmallScrolls, 0, "within-row scrolling does not fetch another media page");
      if (!baseline) assert.ok(gallery.cardRendersDuring30SmallScrolls <= before.cards,
        "within-row scrolling does not repeatedly rerender every memoized card");
      await page.evaluate(() => {
        const stats = window.__startupFixture;
        stats.holdAdditionalPages = true;
        const slots = [...document.querySelectorAll(".virtual-media-slot")];
        const rowTops = [...new Set(slots.map((slot) => parseFloat(slot.style.top)))].sort((a, b) => a - b);
        const columns = slots.filter((slot) => parseFloat(slot.style.top) === rowTops[0]).length;
        const rowHeight = rowTops[1] - rowTops[0];
        const limit = stats.calls.find(({ command }) => command === "list_media_items").args.query.limit;
        const scroller = document.querySelector(".virtual-media-scroller");
        scroller.scrollTop = Math.max(rowHeight, Math.floor(limit / columns) * rowHeight - scroller.clientHeight / 2);
      });
      await page.waitForFunction(() => window.__startupFixture.pendingPageQueries > 0);
      await quiet(page);
      const retainedCards = await page.evaluate(() => Object.fromEntries(
        [...document.querySelectorAll(".media-card .media-open")].map((card) => {
          const id = card.getAttribute("aria-label").replace(/\.jpg$/, "");
          return [id, window.__startupFixture.rendersById[id]];
        })));
      assert.ok(Object.keys(retainedCards).length > 0, "page arrival test retains already visible media");
      await page.evaluate(() => window.__releaseFixturePages());
      await page.waitForFunction((beforeCount) => document.querySelectorAll(".media-card").length > beforeCount, Object.keys(retainedCards).length);
      await quiet(page);
      gallery.retainedCardsAtPageBoundary = Object.keys(retainedCards).length;
      gallery.retainedCardRendersOnAdditionalPage = await page.evaluate((retained) => Object.entries(retained)
        .reduce((sum, [id, count]) => sum + window.__startupFixture.rendersById[id] - count, 0), retainedCards);
      if (!baseline) assert.equal(gallery.retainedCardRendersOnAdditionalPage, 0,
        "a newly loaded page must not rerender already visible memoized cards");

      // Exercise real React handlers after that later page has committed. A
      // stale item-index closure can appear correct by fetching the range
      // again; the zero-additional-query gate catches that hidden regression.
      const selectionStart = await page.evaluate(() => window.__startupFixture.calls
        .find(({ command }) => command === "list_media_items").args.query.limit);
      const queriesBeforeSelection = await page.evaluate(() => window.__startupFixture.calls
        .filter(({ command }) => command === "list_media_items").length);
      for (const [index, modifier] of [[selectionStart, "ctrlKey"], [selectionStart + 3, "shiftKey"]]) {
        await page.evaluate(({ index, modifier }) => {
          const button = document.querySelector(`[data-media-id="media-${index}"] .media-open`);
          if (!button) throw new Error(`Newly loaded item ${index} is not rendered`);
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, [modifier]: true }));
        }, { index, modifier });
        await page.waitForFunction((index) => document.querySelector(`[data-media-id="media-${index}"] .media-card`)?.classList.contains("is-selected"), index);
      }
      await page.waitForFunction(() => document.querySelectorAll(".media-card.is-selected").length === 4);
      await quiet(page);
      const selection = await page.evaluate(() => ({
        ids: [...document.querySelectorAll(".media-card.is-selected")].map((card) => card.parentElement.dataset.mediaId).sort(),
        queries: window.__startupFixture.calls.filter(({ command }) => command === "list_media_items").length,
      }));
      assert.deepEqual(selection.ids, Array.from({ length: 4 }, (_, index) => `media-${selectionStart + index}`).sort(),
        "Ctrl anchor and Shift range include all media in the newly arrived page");
      assert.equal(selection.queries, queriesBeforeSelection, "range selection uses the current loaded-page index without refetching");
      await page.evaluate((index) => document.querySelector(`[data-media-id="media-${index}"] .media-open`)
        .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })), selectionStart + 1);
      await page.waitForFunction(() => document.querySelectorAll(".media-card.is-selected").length === 3);
      assert.equal(await page.evaluate((index) => document.querySelector(`[data-media-id="media-${index}"] .media-card`)
        .classList.contains("is-selected"), selectionStart + 1), false, "Ctrl can toggle a newly loaded selected item off");
      gallery.newPageRangeSelection = { selected: selection.ids.length, additionalPageQueries: selection.queries - queriesBeforeSelection, ctrlTogglePassed: true };
      metrics.gallery = gallery;
    }
    const diagnostics = await page.evaluate(() => {
      const stats = window.__startupFixture;
      const tasks = stats.longTasks.filter((task) => task.startTime >= stats.renderStarted);
      return { unexpected: stats.unexpected, commits: stats.commits.length,
        reactRenderDurationMs: Math.round(stats.commits.reduce((sum, item) => sum + item.actualDuration, 0)),
        longTasks: { count: tasks.length, totalMs: Math.round(tasks.reduce((sum, item) => sum + item.duration, 0)),
          longestMs: Math.round(Math.max(0, ...tasks.map((item) => item.duration))) } };
    });
    assert.deepEqual(diagnostics.unexpected, [], "all native effects remain isolated and expected");
    assert.deepEqual(errors, [], "no browser/React runtime errors");
    Object.assign(metrics[view], diagnostics);
    await page.close();
  }
  console.log(JSON.stringify(metrics, null, 2));
  console.log(baseline ? "MEASURED 0.2.1 baseline (optimization gates disabled)" : "PASS startup/thumbnail/scroll performance contracts");
} finally {
  await browser?.close();
  await server.close();
}
