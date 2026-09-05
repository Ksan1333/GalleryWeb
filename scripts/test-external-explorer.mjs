// Isolated headless React integration: no desktop, screenshots, user files or database.
// Only MediaViewer's rendering is replaced; explorer, query/rank resolution,
// paging, close restoration and history all use the actual application components.
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const server = await createServer({
  root, configFile: false, logLevel: "error",
  plugins: [{
    name: "external-explorer-viewer-double", enforce: "pre",
    transform(_code, id) {
      if (!id.replaceAll("\\", "/").split("?")[0].endsWith("/src/components/MediaViewer.tsx")) return;
      return `import React, {useEffect} from 'react';
        export function MediaViewer(props) {
          useEffect(() => { window.__externalFixture.viewerMounts += 1; }, []);
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
            ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
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
  stats.makeItem = (folder = "", index, extended = false) => ({
    id: `${folder || "drive"}-${index}`, rootId: "fixture-root",
    relativePath: `${folder ? folder + "/" : ""}media-${index}.jpg`,
    path: `${extended ? "\\\\?\\" : ""}E:\\${folder ? folder + "\\" : ""}media-${index}.jpg`,
    name: `media-${index}.jpg`, kind: "image", width: 100, height: 100,
    mimeType: "image/jpeg", sizeBytes: 1, isFavorite: false, ageRating: "SFW", tags: [],
    modifiedAt: "2026-09-05T00:00:00Z", thumbnailPath: image,
  });
  const normalize = path => (path ?? "").replace(/^\\\\\?\\/, "").replaceAll("/", "\\");
  window.__TAURI_INTERNALS__ = {
    convertFileSrc: () => image,
    invoke: async (command, args = {}) => {
      stats.calls.push({command, args});
      if (command === "get_preferences") return {};
      if (command === "list_library_roots") return [{id:"fixture-root", path:"E:\\", displayName:"Fixture", isPriority:true, mediaCount:3000}];
      if (command === "list_tag_translations") return {};
      if (command === "list_media_folders" || command === "list_tags") return [];
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
    await page.waitForFunction(id => document.querySelector('[data-testid="viewer-state"]')?.textContent.includes(`"currentId":"${id}"`), `${folder || "drive"}-${index}`);
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
} finally {
  await browser?.close();
  await server.close();
}
