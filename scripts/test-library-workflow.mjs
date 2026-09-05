import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import "./test-priority-gallery.mjs";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hookCode = ts.transpileModule(read("src/hooks/useViewerFullscreen.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fullscreenHarness(initial = false) {
  const state = { native: initial, rendered: false, writes: [], fail: false };
  const effects = [];
  const module = { exports: {} };
  const window = {
    isFullscreen: async () => state.native,
    setFullscreen: async (next) => {
      if (state.fail) throw new Error("native fullscreen failure");
      state.writes.push(next);
      state.native = next;
    },
    onResized: async () => () => {},
  };
  vm.runInNewContext(hookCode, {
    exports: module.exports, module,
    require: (name) => {
      if (name === "react") return {
        useCallback: (callback) => callback,
        useRef: (current) => ({ current }),
        useState: (value) => [value, (next) => { state.rendered = next; }],
        useEffect: (effect) => effects.push(effect),
      };
      if (name === "@tauri-apps/api/window") return { getCurrentWindow: () => window };
      if (name === "../services/native") return { isTauriRuntime: () => true };
      return require(name);
    },
  });
  const api = module.exports.useViewerFullscreen({ current: {} });
  const cleanups = effects.map((effect) => effect());
  return { state, api, unmount: () => cleanups.forEach((cleanup) => cleanup?.()) };
}

test("fullscreen uses the native window and restores its previous state on close", async () => {
  const { state, api, unmount } = fullscreenHarness();
  await settle();
  await api.changeFullscreen();
  assert.equal(state.native, true);
  assert.equal(state.rendered, true);
  unmount();
  await settle();
  assert.deepEqual(state.writes, [true, false]);
});

test("rapid fullscreen toggles are serialized and Escape exits without closing the viewer", async () => {
  const { state, api, unmount } = fullscreenHarness();
  await Promise.all([api.changeFullscreen(), api.changeFullscreen()]);
  assert.deepEqual(state.writes, [true, false]);
  await api.changeFullscreen(true);
  await api.changeFullscreen(false);
  assert.equal(state.native, false);
  unmount();
  await settle();
});

test("a pre-existing fullscreen window is preserved and failed commands remain recoverable", async () => {
  const inherited = fullscreenHarness(true);
  await settle();
  inherited.unmount();
  await settle();
  assert.deepEqual(inherited.state.writes, []);
  const current = fullscreenHarness();
  current.state.fail = true;
  await assert.rejects(current.api.changeFullscreen(), /native fullscreen failure/);
  assert.equal(current.state.native, false);
  current.state.fail = false;
  await current.api.changeFullscreen();
  assert.equal(current.state.native, true);
  current.unmount();
  await settle();
});

test("folder browsing is lazy, refresh reaches disk, and viewer caches use a catalog revision", () => {
  const browser = read("src/components/FileSystemBrowser.tsx");
  const collection = read("src/components/MediaCollection.tsx");
  const viewer = read("src/components/MediaViewer.tsx");
  const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
  assert.ok(browser.includes("browseFileSystem(path, scan)"));
  assert.ok(browser.includes('const EXPLORER_MEDIA_KINDS: MediaKind[] = ["image", "gif", "video", "pdf", "archive"]'));
  assert.ok(browser.includes("kinds={EXPLORER_MEDIA_KINDS}"), "stable filters preserve the restored scroll position");
  assert.ok(collection.includes("await syncMediaFolder(initialRootId, initialFolderPath)"));
  assert.ok(collection.includes("refreshCatalogFromDisk()"));
  assert.ok(viewer.includes("collection.revision"));
  assert.ok(!viewer.includes("コントロールパネルを非表示"));
  assert.ok(capabilities.permissions.includes("core:window:allow-set-fullscreen"));
  assert.ok(capabilities.permissions.includes("core:window:allow-is-fullscreen"));
});
