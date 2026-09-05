// Isolated headless React integration: no desktop, screenshots, user files or database.
// Unless --first-paint is used, MediaViewer's rendering is replaced; explorer, query/rank resolution,
// paging, close restoration and history all use the actual application components.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const firstPaint = process.argv.includes("--first-paint");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const server = await createServer({
  root, configFile: false, logLevel: "error",
  plugins: [{
    name: "external-explorer-viewer-double", enforce: "pre",
    transform(_code, id) {
      if (firstPaint) return;
      if (!id.replaceAll("\\", "/").split("?")[0].endsWith("/src/components/MediaViewer.tsx")) return;
      return `import React, {useEffect} from 'react';
        export function MediaViewer(props) {
          useEffect(() => { window.__externalFixture.viewerMounts += 1; }, []);
          useEffect(() => { props.onVisualReady?.(props.currentId); }, [props.currentId]);
          const snapshot = { currentId: props.currentId, currentIndex: props.collection?.currentIndex,
            query: props.collection?.query, totalCount: props.collection?.totalCount,
            indexed: props.collection?.indexedItems.map(([index, item]) => [index, item.id]),
            itemIds: props.items.map(item => item.id) };
          return React.createElement('section', {role:'dialog', 'aria-modal':true,
            'aria-label':'External viewer fixture', style:{position:'fixed', inset:40, zIndex:99999, background:'#222'}},
            React.createElement('output', {'data-testid':'viewer-state'}, JSON.stringify(snapshot)),
            React.createElement('button', {onClick:props.onClose}, 'Close fixture viewer'),
            React.createElement('button', {onClick:() => {
              const index = props.collection.currentIndex + 1;
              const item = window.__externalFixture.makeItem(props.collection.query.folderPath, index);
              props.onCurrentIdChange(item.id, item, index);
            }}, 'Next fixture media'));
        }`;
    },
  }, react(), {
    name: "external-explorer-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__external_explorer_test", (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body><div id="root"></div>
          <script type="module">
            import RefreshRuntime from '/@react-refresh';
            RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
            window.__vite_plugin_react_preamble_installed__ = true;
          </script>
          <script type="module" src="/@vite/client"></script>
          <script type="module">
            import React from '/node_modules/.vite/deps/react.js';
            const {useState} = React;
            import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
            import {FileSystemBrowser} from '/src/components/FileSystemBrowser.tsx';
            import App from '/src/App.tsx';
            import {externalExplorerTarget} from '/src/services/explorerNavigation.ts';
            import '/src/App.css';
            function Fixture() {
              const [batch, setBatch] = useState();
              const [navigation, setNavigation] = useState();
              const [revision, setRevision] = useState(0);
              window.__sendExternal = (requestId, folder, index, extended = false) => {
                const item = window.__externalFixture.makeItem(folder, index, extended);
                const next = {requestId, currentId:item.id, items:[item]};
                setBatch(next); setNavigation(externalExplorerTarget(next).request);
              };
              window.__rerenderExternalParent = () => setRevision(value => value + 1);
              const target = batch && externalExplorerTarget(batch);
              return React.createElement('div', {className:'app-shell', 'data-parent-revision':revision},
                React.createElement('main', {className:'main-panel'},
                  React.createElement('header', {className:'topbar'}, 'External explorer fixture'),
                  React.createElement(FileSystemBrowser, {
                    refreshVersion:0, navigationRequest:navigation,
                    openRequest:target ? {requestId:target.request.requestId, item:target.item} : undefined,
                    onDataChanged:() => setRevision(value => value + 1),
                    onOpenRequestClose:() => { setBatch(undefined); setNavigation(undefined); setRevision(value => value + 1); },
                  })));
            }
            ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(new URLSearchParams(location.search).has('cold') ? App : Fixture));
          </script></body></html>`);
      });
    },
  }],
  optimizeDeps: { entries: ["src/components/FileSystemBrowser.tsx"], include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/src-tauri/**", "**/release/**"] } },
});

function installNativeFixture() {
  const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#b892ec"/></svg>');
  const stats = window.__externalFixture = { calls: [], unexpected: [], viewerMounts: 0 };
  const cold = new URLSearchParams(location.search).has('cold');
  if (cold) { stats.deferImage = true; stats.holdBrowse = true; }
  stats.makeItem = (folder = "", index, extended = false) => ({
    id: `${folder || "drive"}-${index}`, rootId: "fixture-root",
    relativePath: `${folder ? folder + "/" : ""}media-${index}.jpg`,
    path: `${extended ? "\\\\?\\" : ""}E:\\${folder ? folder + "\\" : ""}media-${index}.jpg`,
    name: `media-${index}.jpg`, kind: "image", width: 100, height: 100,
    mimeType: "image/jpeg", sizeBytes: 1, isFavorite: false, ageRating: "SFW", tags: [],
    modifiedAt: "2026-09-05T00:00:00Z", thumbnailPath: image,
  });
  const normalize = path => (path ?? "").replace(/^\\\\\?\\/, "").replaceAll("/", "\\");
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
  window.__TAURI_INTERNALS__ = {
    metadata: {currentWindow:{label:'main'}, currentWebview:{label:'main'}},
    transformCallback: () => 1,
    convertFileSrc: () => stats.deferImage ? location.origin + "/__priority-image.svg" : image,
    invoke: async (command, args = {}) => {
      stats.calls.push({command, args, at:performance.now()});
      if (command === 'plugin:window|is_fullscreen') return false;
      if (command === 'plugin:window|set_theme') return null;
      if (command.startsWith('plugin:event|')) return 1;
      if (command === 'take_pending_external_media') {
        if (!cold || stats.tookStartup) return null;
        stats.tookStartup = true;
        await new Promise(resolve => { stats.releaseStartup = resolve; });
        const item = stats.makeItem('Books', 900);
        return {requestId:'cold-start', currentId:item.id, items:[item]};
      }
      if (command === 'take_pending_x_url' || command === 'get_thumbnail_precache_status') return null;
      if (command === 'get_ai_analysis_status') return {phase:'idle', categoryCounts:[], previewTags:[], cleanupPending:false};
      if (command === 'get_runtime_info') return {appName:'Fixture', appVersion:'0.2.6', os:'windows', arch:'x86_64', databaseSchemaVersion:9};
      if (command === 'get_library_summary') return {totalItems:3000, images:3000, favorites:0, libraryRoots:1};
      if (command === "get_preferences") return {'onboarding.firstRun.v1':{status:'completed', step:5}};
      if (command === "list_library_roots") return [{id:"fixture-root", path:"E:\\", displayName:"Fixture", isPriority:true, mediaCount:3000}];
      if (command === "list_tag_translations") return {};
      if (command === "list_media_folders" || command === "list_tags") return [];
      if (command === 'get_visual_recommendations') return [];
      if (command === "get_media_page_info") return {totalCount:1000, dateGroups:[]};
      if (command === "get_media_item_index") {
        const index = Number(args.mediaId.slice(args.mediaId.lastIndexOf("-") + 1));
        if (args.mediaId !== `${args.query.folderPath || "drive"}-${index}`) throw new Error("rank query must match the parent folder");
        return index;
      }
      if (command === "list_media_items") {
        const query = args.query ?? {};
        const offset = query.offset ?? 0;
        return Array.from({length:Math.min(query.limit ?? 64, Math.max(0, 1000-offset))}, (_, i) => stats.makeItem(query.folderPath, offset+i));
      }
      if (command === "get_media_thumbnails") return args.mediaIds.map(mediaId => ({mediaId, thumbnailPath:image}));
      if (command === "get_media_thumbnail") return image;
      if (command === "browse_file_system") {
        if (!args.path) return {path:null, parentPath:null, rootId:null, relativeFolder:"", priorityPath:null,
          folders:[{path:"E:\\", displayName:"Eドライブ"}]};
        if (stats.holdBrowse) await new Promise(resolve => { stats.releaseBrowse = resolve; });
        const path = normalize(args.path);
        const relativeFolder = path.slice(3).replace(/\\$/, "");
        return {path:`\\\\?\\${path}`, parentPath:relativeFolder ? "E:\\" : null, rootId:"fixture-root",
          relativeFolder, priorityPath:"E:\\", folders:[]};
      }
      stats.unexpected.push(command);
      throw new Error(`Unexpected isolated fixture native command: ${command}`);
    },
  };
}

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: {width:1440, height:900} });
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.addInitScript(installNativeFixture);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__external_explorer_test`);
  await page.getByRole("button", {name:"Eドライブ"}).waitFor();
  const state = async () => JSON.parse(await page.getByTestId("viewer-state").textContent());
  const ranks = () => page.evaluate(() => window.__externalFixture.calls.filter(call => call.command === "get_media_item_index").length);
  const tick = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const open = async (requestId, folder, index, extended = false) => {
    await page.evaluate(args => window.__sendExternal(...args), [requestId, folder, index, extended]);
    await page.waitForFunction(([id, index]) => {
      const text = document.querySelector('[data-testid="viewer-state"]')?.textContent;
      if (!text) return false;
      const value = JSON.parse(text);
      return value.currentId === id && value.currentIndex === index;
    }, [`${folder || "drive"}-${index}`, index]);
    const current = await state();
    assert.equal(current.currentIndex, index);
    assert.equal(current.totalCount, 1000);
    assert.equal(current.query.folderPath, folder);
    assert.equal(current.query.rootId, "fixture-root");
    assert.ok(current.indexed.some(([rank, id]) => rank === index && id === current.currentId));
  };
  const closeAndCheckPosition = async (folder, index) => {
    await page.getByRole("button", {name:"Close fixture viewer"}).click();
    await page.getByRole("dialog").waitFor({state:"detached"});
    const id = `${folder || "drive"}-${index}`;
    await page.locator(`[data-media-id="${id}"]`).waitFor();
    const position = await page.evaluate(id => {
      const host = document.querySelector(".virtual-media-scroller");
      const card = document.querySelector(`[data-media-id="${id}"]`);
      const parent = host.getBoundingClientRect(), bounds = card.getBoundingClientRect();
      return {top:host.scrollTop, visible:bounds.top >= parent.top - 1 && bounds.bottom <= parent.bottom + 1,
        address:document.querySelector('[aria-label="フォルダーのパス"]').value};
    }, id);
    assert.ok(position.visible, `return target must be fully visible: ${JSON.stringify(position)}`);
    assert.equal(position.address, `\\\\?\\E:\\${folder}`);
    await page.evaluate(() => window.__rerenderExternalParent());
    await tick();
    assert.equal(await page.getByRole("dialog").count(), 0, "consumed external request must not reopen after the parent rerenders");
    assert.equal(await page.locator(".virtual-media-scroller").evaluate(host => host.scrollTop), position.top,
      "closing/removing external props must not reset the parent gallery scroll");
    return position;
  };

  if (firstPaint) {
    let releaseImage;
    const imageBarrier = new Promise(resolve => { releaseImage = resolve; });
    await page.route('**/__priority-image.svg*', async route => {
      await imageBarrier;
      await route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'});
    });
    await page.evaluate(() => {
      const stats = window.__externalFixture;
      stats.calls = []; stats.deferImage = true; stats.holdBrowse = true;
      document.addEventListener('load', event => {
        if (event.target instanceof HTMLImageElement && event.target.closest('.pv-viewer-main')) stats.visualLoadedAt = performance.now();
      }, true);
      window.__sendExternal('visual-first', 'Books', 900);
    });
    await page.getByRole('dialog').waitFor();
    await page.locator('.pv-viewer-main img').waitFor({state:'attached'});
    await tick();
    const beforeVisual = await page.evaluate(() => window.__externalFixture.calls.map(call => call.command));
    assert.ok(!beforeVisual.some(command => ['browse_file_system','list_media_items','get_media_page_info','get_media_item_index','get_media_thumbnails','get_media_thumbnail','list_tag_translations','get_visual_recommendations'].includes(command)), JSON.stringify(beforeVisual));
    assert.equal(await page.locator('.pv-media-info-panel').count(), 0);
    releaseImage();
    await page.waitForFunction(() => Boolean(window.__externalFixture.visualLoadedAt && window.__externalFixture.releaseBrowse));
    assert.equal(await page.locator('.pv-viewer-main img').evaluate(img => img.complete && img.naturalWidth === 100), true);
    await page.evaluate(() => { window.__firstViewerImage = document.querySelector('.pv-viewer-main img'); });
    assert.equal(await ranks(), 0, 'slow folder listing must not prevent image display');
    await page.evaluate(() => { window.__externalFixture.holdBrowse = false; window.__externalFixture.releaseBrowse(); });
    await page.waitForFunction(() => window.__externalFixture.calls.some(call => call.command === 'get_media_item_index'));
    await tick();
    assert.equal(await page.evaluate(() => window.__firstViewerImage === document.querySelector('.pv-viewer-main img')), true, 'hydrate the same viewer, never reopen or decode again');
    assert.equal(await page.evaluate(() => window.__externalFixture.calls.filter(call => call.command === 'browse_file_system').every(call => call.at > window.__externalFixture.visualLoadedAt)), true);
    await page.evaluate(() => window.__sendExternal('same-visible-image-again', 'Books', 900));
    await page.waitForFunction(() => window.__externalFixture.calls.filter(call => call.command === 'get_media_item_index').length === 2);
    assert.equal(await page.evaluate(() => window.__firstViewerImage === document.querySelector('.pv-viewer-main img')), true, 'a new request for the already displayed file does not get stuck waiting for another image load');
    await page.getByRole('button', {name:'閉じる', exact:true}).first().click();
    await page.getByRole('dialog').waitFor({state:'detached'});
    assert.match(await page.getByRole('textbox', {name:'フォルダーのパス'}).inputValue(), /Books$/);
    assert.deepEqual(errors, []);
    console.log('PASS actual image decodes before folder/count/rank/thumbnails; slow surrounding data never blocks image; same viewer hydrates and closes into parent');

    const coldPage = await browser.newPage({viewport:{width:1440, height:900}});
    coldPage.on('pageerror', error => errors.push(error.message));
    await coldPage.addInitScript(installNativeFixture);
    let releaseColdImage;
    const coldImageBarrier = new Promise(resolve => { releaseColdImage = resolve; });
    await coldPage.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await coldPage.route('**/__priority-image.svg*', async route => {
      await coldImageBarrier;
      await route.fulfill({contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'});
    });
    await coldPage.goto(`http://127.0.0.1:${server.httpServer.address().port}/__external_explorer_test?cold=1`);
    await coldPage.waitForFunction(() => Boolean(window.__externalFixture.releaseStartup));
    const heavy = ['browse_file_system','list_media_items','get_media_page_info','get_media_item_index','get_media_thumbnails','get_media_thumbnail','get_visual_recommendations','list_tag_translations','get_library_summary','list_library_roots'];
    assert.deepEqual(await coldPage.evaluate(commands => window.__externalFixture.calls.filter(call => commands.includes(call.command)), heavy), [], 'ordinary startup work must wait for the native launch queue');
    await coldPage.evaluate(() => window.__externalFixture.releaseStartup());
    await coldPage.locator('.pv-viewer-main img').waitFor({state:'attached'});
    await coldPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await coldPage.evaluate(commands => window.__externalFixture.calls.filter(call => commands.includes(call.command)), heavy), [], 'cold startup must prioritize the selected image over home shelves and aggregates');
    releaseColdImage();
    await coldPage.waitForFunction(() => Boolean(window.__externalFixture.releaseBrowse));
    assert.equal(await coldPage.locator('.pv-viewer-main img').evaluate(img => img.complete && img.naturalWidth === 100), true);
    await coldPage.evaluate(() => { window.__externalFixture.holdBrowse = false; window.__externalFixture.releaseBrowse(); });
    await coldPage.waitForFunction(() => window.__externalFixture.calls.some(call => call.command === 'get_media_item_index'));
    assert.deepEqual(await coldPage.evaluate(() => window.__externalFixture.unexpected), []);
    assert.deepEqual(errors, []);
    await coldPage.close();
    console.log('PASS cold App startup waits for external queue, renders image before home/summary/folder queries, then hydrates the parent catalog');

    // Close before the first image response; browsing must resume without ever
    // replaying the consumed request when its delayed response finally arrives.
    let releaseCanceledImage;
    const canceledImageBarrier = new Promise(resolve => { releaseCanceledImage = resolve; });
    await page.route('**/__priority-image.svg*', async route => {
      await canceledImageBarrier;
      await route.abort();
    });
    await page.evaluate(() => {
      window.__externalFixture.holdBrowse = true;
      window.__externalFixture.releaseBrowse = undefined;
      window.__sendExternal('close-before-paint', 'Other', 25);
    });
    await page.locator('.pv-viewer-main img').waitFor({state:'attached'});
    await page.getByRole('button', {name:'閉じる', exact:true}).first().click();
    await page.waitForFunction(() => Boolean(window.__externalFixture.releaseBrowse));
    await page.evaluate(() => { window.__externalFixture.holdBrowse = false; window.__externalFixture.releaseBrowse(); });
    releaseCanceledImage();
    await page.waitForFunction(() => document.querySelector('[aria-label="フォルダーのパス"]').value.endsWith('Other'));
    await tick();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS closing before image load resumes parent browsing and never reopens a canceled viewer');
  } else {
  await open("deep-first", "Books", 900);
  assert.equal(await ranks(), 1);
  const beforeClose = await page.evaluate(() => window.__externalFixture.calls.filter(call => call.command === "list_media_items").map(call => call.args.query.offset));
  assert.ok(beforeClose.length <= 3 && beforeClose.every(offset => offset < 128 || offset >= 896), "opening a deep item must not load 900 preceding files");
  await page.getByRole("button", {name:"Next fixture media"}).click();
  assert.equal((await state()).currentIndex, 901);
  const deepPosition = await closeAndCheckPosition("Books", 901);
  assert.ok(deepPosition.top > 1000, "deep target restoration must not remain at the first row");
  assert.equal(await ranks(), 1);
  console.log("PASS deep external item: rank900/1000, bounded paging, viewer next901, parent folder and scroll retained");

  await open("same-parent-second", "Books", 950);
  assert.equal(await ranks(), 2);
  await page.evaluate(() => window.__rerenderExternalParent());
  await tick();
  assert.equal(await ranks(), 2, "same request is resolved only once despite new prop objects");
  await closeAndCheckPosition("Books", 950);
  await open("other-parent-third", "Other", 25);
  assert.equal(await ranks(), 3);
  await closeAndCheckPosition("Other", 25);
  console.log("PASS second requests: same/different parent, exactly one rank lookup per request");

  await open("extended-drive", "", 900, true);
  assert.equal(await ranks(), 4);
  await closeAndCheckPosition("", 900);
  await page.getByRole("button", {name:"戻る", exact:true}).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="フォルダーのパス"]').value.endsWith("Other"));
  await open("same-parent-with-forward", "Other", 26);
  const address = await page.getByRole("textbox", {name:"フォルダーのパス"}).inputValue();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("pixvault:navigate-forward", {detail:{handled:false}, cancelable:true})));
  await tick();
  assert.equal(await page.getByRole("textbox", {name:"フォルダーのパス"}).inputValue(), address, "forward history is suspended while the viewer is open");
  await closeAndCheckPosition("Other", 26);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("pixvault:navigate-forward", {detail:{handled:false}, cancelable:true})));
  await page.waitForFunction(() => document.querySelector('[aria-label="フォルダーのパス"]').value === "\\\\?\\E:\\");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("pixvault:navigate-back", {detail:{handled:false}, cancelable:true})));
  await page.waitForFunction(() => document.querySelector('[aria-label="フォルダーのパス"]').value.endsWith("Other"));
  assert.equal(await page.getByRole("dialog").count(), 0, "history traversal must not replay consumed external requests");
  assert.equal(await ranks(), 5);
  assert.equal(await page.evaluate(() => window.__externalFixture.viewerMounts), 5);
  assert.deepEqual(await page.evaluate(() => window.__externalFixture.unexpected), []);
  assert.deepEqual(errors, []);
  console.log("PASS canonical extended drive root, modal-aware forward, back/forward after close, no duplicate opens or runtime errors");
  }
} finally {
  await browser?.close();
  await server.close();
}
