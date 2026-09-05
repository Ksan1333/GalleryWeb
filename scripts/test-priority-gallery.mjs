// Execute the real native adapter and AST-extracted React query/handler code in
// isolated Node fixtures. No browser, desktop, user catalog, or file mutation.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const sourceCache = new Map();
function source(file) {
  if (!sourceCache.has(file)) {
    const code = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    sourceCache.set(file, ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  }
  return sourceCache.get(file);
}
function nodes(file, predicate) {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(typeof file === "string" ? source(file) : file);
  return found;
}
function variable(file, name) {
  const matches = nodes(file, (node) => ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name) && node.name.text === name);
  assert.equal(matches.length, 1, `exactly one executable ${name} declaration`);
  return matches[0].initializer;
}
function declaration(file, name) {
  const matches = nodes(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `exactly one executable ${name} function`);
  return matches[0];
}
const jsx = (type, props) => ({ type, props });
function execute(code, values = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  }, fileName: "fixture.tsx" }).outputText;
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      throw new Error(`Unmocked fixture import ${name}`);
    },
    useMemo: (create) => create(), useCallback: (callback) => callback,
    ...values,
  });
  return module.exports;
}
const expression = (node, values) => execute(`module.exports = (${node.getText()});`, values);
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function nativeHarness() {
  const calls = [];
  const state = { priority: true, failPriority: false, holdCatalog: false, pendingCatalog: [] };
  const rows = Array.from({ length: 440 }, (_, index) => ({
    id: `media-${index}`, rootId: index < 220 ? "priority-root" : "visited-root",
    path: `X:\\fixture\\${index}.jpg`, name: `${index}.jpg`, kind: "image",
    isFavorite: true, sizeBytes: 100, tags: [],
  }));
  const select = (query) => rows.filter((item) => (!query.priorityOnly || (state.priority && item.rootId === "priority-root"))
    && (!query.rootId || query.rootId === item.rootId));
  const module = { exports: {} };
  const compiled = ts.transpileModule(source("src/services/native.ts").getFullText(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports: module.exports, module,
    require(name) {
      if (name === "../appVersion") return { APP_VERSION: "fixture" };
      if (name === "@tauri-apps/api/core") return {
        convertFileSrc: (value) => value,
        invoke: async (command, args = {}) => {
          calls.push({ command, args: plain(args) });
          if (command === "list_media_items" || command === "get_media_page_info") {
            const result = command === "list_media_items"
              ? select(args.query).slice(args.query.offset, args.query.offset + args.query.limit)
              : { totalCount: select(args.query).length, dateGroups: [] };
            if (state.holdCatalog) await new Promise((resolve) => state.pendingCatalog.push(resolve));
            return result;
          }
          if (command === "set_folder_priority") {
            if (state.failPriority) throw new Error("simulated priority write failure");
            state.priority = args.priority;
            return null;
          }
          if (command === "list_library_roots") return [
            { id: "priority-root", path: "X:\\priority", displayName: "Priority", mediaCount: 220, isPriority: state.priority },
            { id: "visited-root", path: "X:\\visited", displayName: "Visited", mediaCount: 220, isPriority: false },
          ];
          if (command === "get_library_summary") return { totalItems: rows.length, images: rows.length, favorites: rows.length, libraryRoots: 2 };
          throw new Error(`Unexpected isolated native command ${command}`);
        },
      };
      throw new Error(`Unexpected native adapter import ${name}`);
    },
    window: { __TAURI_INTERNALS__: {}, dispatchEvent() {} },
    CustomEvent, console, setTimeout, clearTimeout,
  });
  return { api: module.exports, calls, state, rows };
}

function appContent(section) {
  const declarations = nodes("src/App.tsx", (node) => ts.isFunctionDeclaration(node) && node.name?.text === "content");
  assert.equal(declarations.length, 1);
  return execute(`${declarations[0].getText()}\nmodule.exports = content();`, {
    section, catalogRefreshVersion: 0, galleryMediaKinds: ["image", "gif"], tagGalleryNavigation: undefined,
    explorerNavigationRequest: undefined, externalTarget: undefined,
    externalStartupChecked: true, externalMediaBatch: undefined,
    refreshSummary() {}, refreshPriorityScope() {}, addFolder() {},
    MediaCollection: "MediaCollection", FileSystemBrowser: "FileSystemBrowser", FolderMediaCollection: "FolderMediaCollection",
    IMAGE_MEDIA_KINDS: ["image", "gif"], VIDEO_MEDIA_KINDS: ["video"], BOOK_MEDIA_KINDS: ["pdf", "archive"],
  });
}
function baseQuery(props) {
  return expression(variable("src/components/MediaCollection.tsx", "baseQuery"), {
    activeKinds: props.kinds, favoritesOnly: props.favoritesOnly, priorityOnly: props.priorityOnly ?? false,
    debouncedSearch: "", initialRootId: props.initialRootId, initialFolderPath: props.initialFolderPath,
    rootId: "", advancedGallerySearch: props.advancedGallerySearch ?? false,
    galleryFilters: { tagIds: [], period: "all" }, displayPreferences: { ageRating: "" },
    gallerySearchModifiedRange: () => ({}), sortBy: "modifiedAt", sortDirection: "desc", groupMode: "none",
  });
}
function fileSystemCollectionProps() {
  const components = nodes("src/components/FileSystemBrowser.tsx", (node) => ts.isJsxSelfClosingElement(node)
    && node.tagName.getText() === "MediaCollection");
  assert.equal(components.length, 1);
  return expression(components[0], {
    MediaCollection: "MediaCollection", revision: 0,
    EXPLORER_MEDIA_KINDS: ["image", "gif", "video", "pdf", "archive"],
    path: "X:\\visited", navigationRequest: undefined, openRequest: undefined, onOpenRequestClose() {},
    deferFolder: false, loadedListing: {},
    sameExplorerPath: (left, right) => left === right, currentOpenRequest: undefined,
    listing: { rootId: "visited-root", relativeFolder: "", path: "X:\\visited", folders: [] },
  }).props;
}
function viewerCollection(query) {
  const viewer = nodes("src/components/MediaCollection.tsx", (node) => ts.isJsxSelfClosingElement(node)
    && node.tagName.getText() === "MediaViewer");
  assert.equal(viewer.length, 1);
  const attribute = viewer[0].attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.getText() === "collection");
  assert.ok(attribute && ts.isJsxExpression(attribute.initializer));
  return expression(attribute.initializer.expression, {
    viewerIncludesAllMedia: true, selectedOutsideCollection: false, baseQuery: query, catalogRevision: 3, pageInfo: { totalCount: 220 },
    selected: { id: "media-0" }, mediaIndexById: new Map([["media-0", 0]]),
    viewerReturnTarget: { current: { index: 0 } }, itemByIndex: new Map(),
  });
}

test("actual App/collection JSX restricts only the normal gallery, including viewer scope", async () => {
  const gallery = appContent("gallery");
  assert.equal(gallery.props.priorityOnly, true);
  assert.equal(gallery.props.viewerIncludesAllMedia, true);
  const { api, calls } = nativeHarness();
  const scoped = baseQuery(gallery.props);
  assert.equal(scoped.priorityOnly, true);
  const list = await api.listMediaItems(scoped);
  const count = await api.getMediaPageInfo(scoped);
  assert.equal(list.data.length, 220);
  assert.equal(count.data.totalCount, 220);
  assert.ok(list.data.every((item) => item.rootId === "priority-root"));
  assert.equal(viewerCollection(scoped).query.priorityOnly, true);

  assert.equal(appContent("allFolders").type, "FileSystemBrowser");
  const folder = baseQuery(fileSystemCollectionProps());
  assert.equal(folder.priorityOnly, false);
  const folderItems = await api.listMediaItems(folder);
  assert.equal(folderItems.data.length, 220);
  assert.ok(folderItems.data.every((item) => item.rootId === "visited-root"));
  assert.equal(viewerCollection(folder).query.priorityOnly, false);

  const favorites = baseQuery(appContent("favorites").props);
  assert.equal(favorites.favoritesOnly, true);
  assert.equal(favorites.priorityOnly, false);
  assert.equal((await api.getMediaPageInfo(favorites)).data.totalCount, 440);
  assert.equal((await api.listMediaItems(favorites)).data.length, 440);
  for (const section of ["folders", "videos", "books"]) assert.notEqual(appContent(section).props.priorityOnly, true);
  assert.deepEqual(calls.filter(({ command }) => command === "list_media_items").map(({ args }) => args.query.priorityOnly), [true, false, false]);
});

test("native IPC defaults to all folders and separates priority-filtered page/count caches", async () => {
  const { api, calls } = nativeHarness();
  const query = { kind: ["image"], sortBy: "name", limit: 12, offset: 0 };
  const all = await api.listMediaItems(query);
  const priority = await api.listMediaItems({ ...query, priorityOnly: true });
  assert.equal(all.data.length, 12);
  assert.equal(priority.data.length, 12);
  await api.listMediaItems(query);
  await api.listMediaItems({ ...query, priorityOnly: true });
  assert.equal(calls.filter(({ command }) => command === "list_media_items").length, 2);
  assert.equal((await api.getMediaPageInfo(query)).data.totalCount, 440);
  assert.equal((await api.getMediaPageInfo({ ...query, priorityOnly: true })).data.totalCount, 220);
  await api.getMediaPageInfo({ ...query, priorityOnly: true });
  assert.equal(calls.filter(({ command }) => command === "get_media_page_info").length, 2);
  assert.deepEqual(calls.filter(({ command }) => command === "list_media_items").map(({ args }) => args.query.priorityOnly), [false, true]);
});

test("changing priority invalidates page, count, root and summary caches; a failed change preserves them", async () => {
  const { api, calls, state } = nativeHarness();
  const scoped = { priorityOnly: true };
  const warm = () => Promise.all([api.listMediaItems(scoped), api.getMediaPageInfo(scoped), api.listLibraryRoots(), api.getLibrarySummary()]);
  await warm();
  await warm();
  assert.equal(calls.length, 4);
  state.failPriority = true;
  assert.equal((await api.setFolderPriority("priority-root", false)).data, false);
  await warm();
  assert.equal(calls.length, 5, "failed write does not discard valid cached catalog results");
  state.failPriority = false;
  assert.equal((await api.setFolderPriority("priority-root", false)).data, true);
  const [items, count, roots] = await warm();
  assert.equal(items.data.length, 0);
  assert.equal(count.data.totalCount, 0);
  assert.equal(roots.data[0].isPriority, false);
  assert.equal(calls.length, 10, "successful write reloads all four catalog caches");
  assert.equal((await api.listMediaItems({})).data.length, 440, "demotion does not delete ordinary or favorite media");
  await api.setFolderPriority("priority-root", true);
  assert.equal((await api.getMediaPageInfo(scoped)).data.totalCount, 220);
});

test("late pages and counts from the old priority generation cannot resurrect stale caches", async () => {
  for (const initiallyPriority of [true, false]) {
    const { api, calls, state } = nativeHarness();
    state.priority = initiallyPriority;
    state.holdCatalog = true;
    const oldPage = api.listMediaItems({ priorityOnly: true });
    const oldInfo = api.getMediaPageInfo({ priorityOnly: true });
    assert.equal(state.pendingCatalog.length, 2);
    await api.setFolderPriority("priority-root", !initiallyPriority);
    state.holdCatalog = false;
    const expected = initiallyPriority ? 0 : 220;
    assert.equal((await api.listMediaItems({ priorityOnly: true })).data.length, expected);
    assert.equal((await api.getMediaPageInfo({ priorityOnly: true })).data.totalCount, expected);
    state.pendingCatalog.splice(0).forEach((resolve) => resolve());
    const [stalePage, staleInfo] = await Promise.all([oldPage, oldInfo]);
    assert.equal(stalePage.data.length, initiallyPriority ? 220 : 0, "fixture really completes an obsolete page last");
    assert.equal(staleInfo.data.totalCount, initiallyPriority ? 220 : 0);
    const before = calls.length;
    assert.equal((await api.listMediaItems({ priorityOnly: true })).data.length, expected);
    assert.equal((await api.getMediaPageInfo({ priorityOnly: true })).data.totalCount, expected);
    assert.equal(calls.length, before, "the current generation cache survives the late reply");
  }
});

function priorityActionHarness({ addFails = false, scanFails = false, removeFails = false, optionalCallback = true } = {}) {
  const events = [];
  const state = { busy: false, error: undefined };
  const context = {
    listing: { path: "X:\\fixture" },
    setPriorityBusy(value) { state.busy = value; },
    setError(value) { state.error = value; },
    onPriorityChanged: optionalCallback ? () => events.push("priorityChanged") : undefined,
    onChanged: { current: () => events.push("dataChanged") },
    addLibraryRoot: async () => {
      events.push("add");
      return addFails ? { data: null, error: "add failure" } : { data: { id: "fixture" } };
    },
    scanLibrary: async () => { events.push("scan"); return { error: scanFails ? "scan failure" : undefined }; },
    setFolderPriority: async () => { events.push("remove"); return { data: !removeFails, error: removeFails ? "remove failure" : undefined }; },
    load: async (scan = true) => { events.push(scan ? "load" : "loadWithoutScan"); },
  };
  const action = (name) => execute(`${declaration("src/components/FileSystemBrowser.tsx", name).getText()}\nmodule.exports = ${name};`, context);
  return { events, state, prioritize: action("prioritize"), remove: action("removePriority") };
}

test("priority callbacks reflect committed settings before scanning, including scan failure and legacy fallback", async () => {
  for (const scanFails of [false, true]) {
    const fixture = priorityActionHarness({ scanFails });
    await fixture.prioritize();
    assert.deepEqual(fixture.events, scanFails ? ["add", "priorityChanged", "scan"] : ["add", "priorityChanged", "scan", "load"]);
    assert.equal(fixture.state.busy, false);
    if (scanFails) assert.match(fixture.state.error, /scan failure/);
  }
  const failed = priorityActionHarness({ addFails: true });
  await failed.prioritize();
  assert.deepEqual(failed.events, ["add"], "a rejected priority write never announces a catalog change");
  assert.equal(failed.state.busy, false);
  const fallback = priorityActionHarness({ optionalCallback: false, scanFails: true });
  await fallback.prioritize();
  assert.deepEqual(fallback.events, ["add", "dataChanged", "scan"]);
});

test("priority removal notifies only on success and App notification invalidates catalog before refreshing counts", async () => {
  for (const removeFails of [false, true]) {
    const fixture = priorityActionHarness({ removeFails });
    await fixture.remove({ id: "fixture" });
    assert.deepEqual(fixture.events, removeFails ? ["remove"] : ["remove", "priorityChanged", "loadWithoutScan"]);
    assert.equal(fixture.state.busy, false);
  }
  const events = [];
  const callback = expression(variable("src/App.tsx", "refreshPriorityScope"), {
    publishCatalogChange() { events.push("invalidate"); }, refreshSummary() { events.push("overview"); },
  });
  callback();
  assert.deepEqual(events, ["invalidate", "overview"]);
});

test("App add-folder handler publishes a successful priority write even when its later scan fails", async () => {
  const events = [];
  const action = execute(`${declaration("src/App.tsx", "addFolder").getText()}\nmodule.exports = addFolder;`, {
    startOperation: () => ({ update() {}, cancel() {}, succeed() {}, fail() { events.push("failed"); } }),
    setError() {}, setBusy() {}, pickLibraryRoot: async () => ({ data: "X:\\fixture" }),
    addLibraryRoot: async () => { events.push("add"); return { data: { id: "fixture", displayName: "Fixture" } }; },
    publishCatalogChange() { events.push("invalidate"); },
    scanLibrary: async () => { events.push("scan"); return { available: false, error: "scan failure", data: { totalItems: 0 } }; },
    refresh: async () => { events.push("overview"); }, navigateToSection() {}, operationErrorMessage: String,
  });
  await action();
  assert.deepEqual(events, ["add", "invalidate", "scan", "overview", "failed"]);
});

test("viewer page loading and index lookup execute with the gallery priority scope", async () => {
  const { api, calls } = nativeHarness();
  const collection = viewerCollection(baseQuery(appContent("gallery").props));
  const itemRef = { current: new Map() };
  const requestRef = { current: new Map() };
  const values = {
    collectionQuery: collection.query, collectionTotalCount: 220, collectionKey: "scoped-fixture",
    collectionItemsRef: itemRef, collectionPageRequestsRef: requestRef, collectionGenerationRef: { current: 0 },
    activeCollectionIndexRef: { current: 130 }, VIEWER_COLLECTION_PAGE_SIZE: 64,
    listMediaItems: api.listMediaItems, trimViewerCollectionCache: (items) => items,
    setCollectionItems() {},
  };
  const loadCollectionPage = expression(variable("src/components/MediaViewer.tsx", "loadCollectionPage"), values);
  const loadCollectionItem = expression(variable("src/components/MediaViewer.tsx", "loadCollectionItem"), { ...values, loadCollectionPage });
  const item = await loadCollectionItem(130);
  assert.equal(item.id, "media-130");
  assert.equal(item.rootId, "priority-root");
  assert.equal(calls[0].args.query.priorityOnly, true);
  assert.equal(calls[0].args.query.offset, 128);
  assert.equal((await loadCollectionItem(131)).id, "media-131");
  assert.equal(calls.length, 1, "nearby index lookup reuses its priority-scoped rail page");
  const itemAt = expression(variable("src/components/MediaViewer.tsx", "viewerRailItemAt"), {
    viewerRailIncludesAllMedia: true, collectionRailItems: itemRef.current, viewerRailItems: [],
  });
  assert.equal(itemAt(130).id, "media-130");
});

test("actual Shift-range handler forwards priority scope when fetching unloaded selection items", async () => {
  const { api, calls, rows } = nativeHarness();
  const query = baseQuery(appContent("gallery").props);
  const selectedMediaRef = { current: new Map([[rows[0].id, rows[0]]]) };
  const result = { finished: false, error: undefined };
  const handler = expression(variable("src/components/MediaCollection.tsx", "toggleMediaSelection"), {
    baseQuery: query, itemByIndexRef: { current: new Map([[0, rows[0]]]) },
    selectionAnchor: { mediaId: rows[0].id, index: 0 }, selectedMediaRef,
    setSelectedMedia(update) { selectedMediaRef.current = update(selectedMediaRef.current); },
    setSelectionAnchor() {}, cancelRangeSelection() {}, setError(error) { result.error = error; },
    rangeSelectionGeneration: { current: 0 }, rangeSelectionOperation: { current: undefined },
    setRangeSelectionProgress() {}, RANGE_SELECTION_BATCH_SIZE: 500, listMediaItems: api.listMediaItems,
    window: { requestAnimationFrame: (callback) => queueMicrotask(callback) },
    startOperation: () => ({ update() {}, succeed() { result.finished = true; }, fail(error) { result.error = error; } }),
  });
  handler(rows[149], 149, { shiftKey: true });
  for (let attempt = 0; attempt < 30 && !result.finished && !result.error; attempt += 1) await settle();
  assert.equal(result.error, undefined);
  assert.equal(result.finished, true);
  assert.equal(selectedMediaRef.current.size, 150);
  assert.ok([...selectedMediaRef.current.values()].every((item) => item.rootId === "priority-root"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.query.priorityOnly, true);
  assert.equal(calls[0].args.query.limit, 150);
});
