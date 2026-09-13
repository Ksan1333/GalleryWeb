// Execute real preference/geometry/React event code in isolated Node fixtures.
// No native catalog access, browser, screenshot, or user-file mutation.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const file = ts.createSourceFile("MediaCollection.tsx", read("src/components/MediaCollection.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  const found = [];
  const visit = (node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(file);
  assert.equal(found.length, 1, "one real implementation matches this test");
  return found[0];
}
function execute(code, globals = {}, imports = {}) {
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  }, fileName: "fixture.tsx" }).outputText, {
    module, exports: module.exports, CustomEvent,
    require: (name) => {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (Object.hasOwn(imports, name)) return imports[name];
      throw new Error(`Unexpected fixture import: ${name}`);
    }, ...globals,
  });
  return module.exports;
}
function preferencesHarness() {
  const events = [];
  const state = { saved: true, writes: [], current: { gridSize: "maximum", groupMode: "month" } };
  const api = execute(read("src/services/galleryDisplayPreferences.ts"), {
    window: { dispatchEvent: (event) => events.push(event) },
  }, { "./native": {
    getJsonPreference: async () => ({ data: state.current }),
    setJsonPreference: async (key, value) => { state.writes.push({ key, value }); return { data: state.saved }; },
  } });
  return { api, state, events };
}

test("persisted gallery density survives normalization; only successful saves broadcast", async () => {
  const { api, state, events } = preferencesHarness();
  assert.equal((await api.loadGalleryDisplayPreferences()).gridSize, "maximum");
  for (const size of ["minimum", "small", "medium", "large", "maximum"]) {
    assert.equal(api.normalizeGalleryDisplayPreferences({ gridSize: size }).gridSize, size);
  }
  assert.equal(api.normalizeGalleryDisplayPreferences({ gridSize: "invalid" }).gridSize, "medium");
  const next = api.mergeGalleryDisplayPreferences(api.defaultGalleryDisplayPreferences, { gridSize: "small" });
  assert.equal((await api.saveGalleryDisplayPreferences(next)).saved, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.gridSize, "small");
  state.saved = false;
  assert.equal((await api.saveGalleryDisplayPreferences(next)).saved, false);
  assert.equal(events.length, 1);
});

test("all five compact densities change square tile geometry without widening a narrow viewport", () => {
  const { api } = preferencesHarness();
  const node = find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "gridMetrics");
  const metrics = execute(`${node.getText()}; module.exports = gridMetrics;`, {
    VIRTUAL_GAP: 14, galleryCompactCardWidths: api.galleryCompactCardWidths,
  });
  const sizes = ["minimum", "small", "medium", "large", "maximum"];
  const cards = sizes.map((size) => metrics(size, 2330, true));
  assert.equal(api.galleryCompactCardWidths.medium, 112, "default remains Explorer-sized");
  for (let index = 1; index < cards.length; index += 1) {
    assert.ok(cards[index].columns < cards[index - 1].columns);
    assert.ok(cards[index].rowHeight > cards[index - 1].rowHeight);
  }
  for (const size of sizes) {
    for (const width of [70, 390, 760, 1440, 2330]) {
      const card = metrics(size, width, true);
      const actualWidth = (width - 14 * (card.columns - 1)) / card.columns;
      assert.ok(Math.abs(actualWidth - (card.rowHeight - 14)) < 1, "thumbnail and text form one square");
      assert.ok(card.visualHeight < card.rowHeight - 14);
      assert.ok(card.columns * (card.rowHeight - 14) + (card.columns - 1) * 14 <= width);
    }
  }
  const gridSize = find((node) => ts.isVariableDeclaration(node) && node.name.getText() === "gridSize");
  assert.equal(gridSize.initializer.getText(), "displayPreferences.gridSize", "compact mode never overrides the saved setting");
});

function walkJsx(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  const own = predicate(tree) ? [tree] : [];
  const children = tree.props?.children;
  return [...own, ...[children].flat(Infinity).flatMap((child) => walkJsx(child, predicate))];
}
test("selection mode has an explicit open action and Enter never toggles selection", () => {
  const node = find((node) => ts.isVariableDeclaration(node) && node.name.getText() === "MediaCard");
  const card = execute(`module.exports = ${node.initializer.getText()};`, {
    memo: (component) => component, useEffect() {}, markFirstMediaCard() {}, markFirstMediaThumbnail() {},
    Icon: "Icon", LazyMediaVisual: "LazyMediaVisual", mediaKindLabel: () => "画像", mediaKindIcon: () => "image",
    formatBytes: () => "100 B", formatDate: () => "today", formatDuration: () => "0:01",
  });
  const calls = [];
  const item = { id: "a", name: "a.jpg", kind: "image", ageRating: "SFW", sizeBytes: 100, tags: [] };
  const tree = card({ item, itemIndex: 2, gridSize: "medium", compactFileLayout: true,
    selectionMode: true, selected: true, translateTag: (value) => value,
    onOpen: (item, index) => calls.push(["open", item.id, index]),
    onActivate: () => calls.push(["select"]), onToggleSelection: () => calls.push(["select"]),
  });
  const primary = walkJsx(tree, (node) => node.props?.className === "media-open")[0];
  let prevented = false;
  primary.props.onKeyDown({ key: "Enter", preventDefault: () => { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true, "prevent synthetic button click from toggling selected state");
  assert.deepEqual(calls, [["open", "a", 2]]);
  primary.props.onKeyDown({ key: "Enter", shiftKey: true });
  assert.equal(calls.length, 1, "modified Enter retains range-selection behavior");
  const explicit = walkJsx(tree, (node) => node.props?.["aria-label"] === "a.jpgを開く（選択を保持）")[0];
  explicit.props.onClick();
  assert.deepEqual(calls[1], ["open", "a", 2]);
});

test("all scoped collection viewers default to paging and seed out-of-cache current media", () => {
  const component = find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "MediaCollection");
  const setting = component.parameters[0].name.elements.find((element) => element.name.getText() === "viewerIncludesAllMedia");
  assert.equal(setting.initializer.getText(), "true", "favorites and media folders inherit complete scoped paging");
  const collection = find((node) => ts.isJsxAttribute(node) && node.name.getText() === "collection");
  const selected = { id: "outside-loaded-window" };
  const query = { favoritesOnly: true, rootId: "root", folderPath: "nested", search: "cat", kind: ["image"], ageRating: "SFW" };
  const result = execute(`module.exports = (${collection.initializer.expression.getText()});`, {
    viewerIncludesAllMedia: true, selectedOutsideCollection: false, baseQuery: query,
    catalogRevision: 1, pageInfo: { totalCount: 220000 }, selected,
    mediaIndexById: new Map(), itemByIndex: new Map([[0, { id: "first" }]]),
    viewerReturnTarget: { current: { mediaId: selected.id, index: 219000 } },
  });
  assert.equal(result.query, query, "never broadens favorites/type/search/folder/age filters");
  assert.equal(result.totalCount, 220000);
  assert.equal(result.currentIndex, 219000);
  assert.equal(result.indexedItems.length, 2, "does not allocate the whole catalog");
  assert.equal(result.indexedItems[1][1], selected);
  const viewer = find((node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "MediaViewer");
  const items = viewer.attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.getText() === "items");
  const fallback = execute(`module.exports = (${items.initializer.expression.getText()});`, {
    selectedOutsideCollection: true, selected, loadedItems: [{ id: "different-filtered-file" }],
  });
  assert.equal(fallback.length, 1, "filtered-out external file does not navigate an unrelated cached subset");
  assert.equal(fallback[0], selected);
});

const openEffect = find((node) => ts.isCallExpression(node) && node.expression.getText() === "useEffect"
  && node.arguments[0].getText().includes("getMediaItemIndex(request.item.id"));
const immediateOpenEffect = find((node) => ts.isCallExpression(node) && node.expression.getText() === "useEffect"
  && node.arguments[0].getText().includes("setSelected(openRequest.item)"));
const mediaPageSize = execute(`module.exports = ${find((node) => ts.isVariableDeclaration(node)
  && node.name.getText() === "MEDIA_PAGE_SIZE").initializer.getText()};`);
function runOpenEffect(state, getMediaItemIndex) {
  const context = {
    openRequest: state.request, handledOpenRequestId: state.handled,
    positionedOpenRequestId: state.positioned, deferCatalog: Boolean(state.deferred),
    displayPreferencesLoaded: true, catalogReadyQueryKey: state.readyQuery ?? (state.countFailed ? "" : "query"),
    catalogFailedQueryKey: state.countFailed ? "query" : "", queryKey: "query",
    baseQuery: state.query, viewerReturnTarget: state.target,
    selected: state.selected, selectedOutsideCollection: state.outside,
    pagesRef: state.pages, MEDIA_PAGE_SIZE: mediaPageSize,
    getMediaItemIndex, setSelectedOutsideCollection: (value) => { state.outside = value; state.outsideChanges.push(value); },
    setSelected: (value) => { state.selected = value; state.opens += 1; },
    setError: (value) => { state.error = value; },
  };
  execute(`module.exports = (${immediateOpenEffect.arguments[0].getText()})();`, context);
  // Model the render after the immediate-open state updates. Mutable refs are
  // shared by both real effects; selected/outside are React render snapshots.
  return execute(`module.exports = (${openEffect.arguments[0].getText()})();`, {
    ...context, selected: state.selected, selectedOutsideCollection: state.outside,
  });
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function requestState() {
  const request = { requestId: "request-1", item: { id: "file-1" } };
  return { request, query: { folderPath: "folder" }, selected: request.item,
    outside: true, outsideChanges: [], pages: { current: new Map() },
    handled: { current: undefined }, positioned: { current: undefined }, target: { current: undefined }, opens: 0 };
}
test("external-open resolves one SQL rank, restores target and consumes each request only once", async () => {
  const state = requestState();
  let queries = 0;
  const api = async (id, query) => { queries += 1; assert.equal(id, "file-1"); assert.equal(query, state.query); return { data: 219999 }; };
  runOpenEffect(state, api);
  await tick();
  assert.equal(state.target.current.index, 219999);
  assert.equal(state.outside, false);
  assert.equal(state.selected.id, "file-1");
  runOpenEffect(state, api);
  await tick();
  assert.equal(queries, 1);
  assert.equal(state.opens, 1);
});

test("external-open discards stale results and never fabricates a filtered-out position", async () => {
  const stale = requestState();
  let finish;
  const cleanup = runOpenEffect(stale, () => new Promise((resolve) => { finish = resolve; }));
  cleanup();
  finish({ data: 10 });
  await tick();
  assert.equal(stale.opens, 1, "file is already visible before its rank request");
  assert.equal(stale.positioned.current, undefined);
  assert.equal(stale.target.current, undefined);
  const filtered = requestState();
  runOpenEffect(filtered, async () => ({ data: null }));
  await tick();
  assert.equal(filtered.selected.id, "file-1");
  assert.equal(filtered.outside, true);
  assert.equal(filtered.target.current, undefined);
});

test("external file still opens in isolation when folder aggregate fails", () => {
  const state = requestState();
  state.countFailed = true;
  runOpenEffect(state, () => { throw new Error("No rank query after failed count"); });
  assert.equal(state.selected.id, "file-1");
  assert.equal(state.outside, true);
  assert.equal(state.target.current, undefined);
});

test("external file opens before any deferred folder aggregation or rank lookup", () => {
  const state = requestState();
  state.deferred = true;
  runOpenEffect(state, () => { throw new Error("Rank work must wait for the visual"); });
  assert.equal(state.selected.id, "file-1");
  assert.equal(state.outside, true);
  assert.equal(state.positioned.current, undefined);
});

test("known external files reuse loaded page ranks without detaching the collection or querying SQL", () => {
  for (const [page, offset] of [[0, 0], [14, 1]]) {
    const state = requestState();
    state.selected = { id: "previous-file" };
    state.outside = false;
    const items = [{ id: "preceding-file" }, { id: "following-file" }];
    items[offset] = state.request.item;
    state.pages.current.set(page, items);
    const api = () => { throw new Error("A loaded page already supplies the exact rank"); };
    runOpenEffect(state, api);
    assert.equal(state.target.current.mediaId, state.request.item.id);
    assert.equal(state.target.current.index, page * mediaPageSize + offset);
    assert.equal(state.positioned.current, state.request.requestId);
    assert.deepEqual(state.outsideChanges, [false], "known files never temporarily detach the viewer collection");
    assert.equal(state.selected, state.request.item);
    assert.equal(state.pages.current.get(page), items, "the existing page cache is retained");
    runOpenEffect(state, api);
    assert.equal(state.opens, 1, "a consumed request cannot reopen or reposition the file");
    assert.deepEqual(state.outsideChanges, [false]);
  }
});

test("reopening the current file retains its known rank even outside the loaded gallery pages", () => {
  const state = requestState();
  state.outside = false;
  state.target.current = { mediaId: state.request.item.id, index: 219999 };
  state.pages.current.set(0, [{ id: "unrelated-loaded-file" }]);
  runOpenEffect(state, () => { throw new Error("The current viewer rank must not be resolved again"); });
  assert.equal(state.target.current.mediaId, state.request.item.id);
  assert.equal(state.target.current.index, 219999);
  assert.equal(state.positioned.current, state.request.requestId);
  assert.deepEqual(state.outsideChanges, [false]);
  assert.equal(state.selected, state.request.item);
});

test("external-open never reuses cached ranks from a different folder/filter query", async () => {
  const state = requestState();
  state.readyQuery = "previous-query";
  state.outside = false;
  state.target.current = { mediaId: state.request.item.id, index: 900 };
  state.pages.current.set(0, [state.request.item]);
  let queries = 0;
  const api = async (id, query) => {
    queries += 1;
    assert.equal(id, state.request.item.id);
    assert.equal(query, state.query);
    return { data: 219999 };
  };
  runOpenEffect(state, api);
  assert.equal(state.selected, state.request.item, "unknown-folder media is visible immediately");
  assert.equal(state.target.current, undefined, "an old current rank is not assigned to the new scope");
  assert.equal(state.positioned.current, undefined);
  assert.equal(state.outside, true);
  assert.equal(queries, 0, "rank lookup waits for the matching catalog scope");
  state.readyQuery = "query";
  runOpenEffect(state, api);
  await tick();
  assert.equal(queries, 1);
  assert.equal(state.target.current.index, 219999, "the actual new-scope rank replaces the old page-zero match");
  assert.equal(state.outside, false);
});

test("opening an unknown file after a known one isolates it until its own SQL rank resolves", async () => {
  const state = requestState();
  state.pages.current.set(2, [state.request.item]);
  runOpenEffect(state, () => { throw new Error("The first file is cached"); });
  assert.equal(state.target.current.index, 2 * mediaPageSize);
  state.request = { requestId: "request-2", item: { id: "file-2" } };
  let finish;
  runOpenEffect(state, (id, query) => {
    assert.equal(id, "file-2");
    assert.equal(query, state.query);
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.equal(state.selected, state.request.item);
  assert.equal(state.target.current, undefined, "the preceding file's rank is never reused");
  assert.equal(state.outside, true);
  assert.deepEqual(state.outsideChanges, [false, true]);
  finish({ data: 219998 });
  await tick();
  assert.equal(state.target.current.mediaId, "file-2");
  assert.equal(state.target.current.index, 219998);
  assert.equal(state.outside, false);
  assert.equal(state.opens, 2);
  assert.equal(state.pages.current.get(2)[0].id, "file-1", "unknown-file resolution preserves already loaded pages");
});

test("a failed external-file rank lookup keeps the file open without a fabricated position", async () => {
  const state = requestState();
  state.target.current = { mediaId: "previous-file", index: 12 };
  runOpenEffect(state, async () => ({ data: 0, error: "simulated rank failure" }));
  await tick();
  assert.equal(state.selected, state.request.item);
  assert.equal(state.target.current, undefined);
  assert.equal(state.outside, true);
  assert.equal(state.positioned.current, state.request.requestId);
  assert.match(state.error, /simulated rank failure/);
});
