import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
function execute(source, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, ...globals });
  return module.exports;
}
const navigation = execute(read("src/services/explorerNavigation.ts"));

test("parent paths preserve normal, verbatim and UNC roots without treating file URLs as paths", () => {
  for (const [file, folder] of [
    ["C:\\Media\\作品.webp", "C:\\Media"],
    ["E:\\photo.jpg", "E:\\"],
    ["\\\\?\\C:\\photo.jpg", "\\\\?\\C:\\"],
    ["\\\\?\\C:\\本\\comic.zip", "\\\\?\\C:\\本"],
    ["\\\\server\\share\\photo.gif", "\\\\server\\share"],
    ["\\\\?\\UNC\\server\\share\\photo.gif", "\\\\?\\UNC\\server\\share"],
    ["/photo.png", "/"],
    ["/media/photo.png", "/media"],
  ]) assert.equal(navigation.parentFilePath(file), folder);
  assert.equal(navigation.parentFilePath("https://example.com/photo.jpg"), undefined);
  assert.equal(navigation.parentFilePath("photo.jpg"), undefined);
  assert.equal(navigation.sameExplorerPath("\\\\?\\C:\\Photos\\", "c:/photos"), true);
  assert.equal(navigation.sameExplorerPath("\\\\?\\UNC\\server\\share", "\\\\SERVER\\SHARE\\"), true);
  assert.equal(navigation.sameExplorerPath("/Media", "/media"), false);
  assert.equal(navigation.joinFolderPath("E:\\", "旅行/2026"), "E:\\旅行\\2026");
});

test("external batch selects the requested file's parent, including corrected invalid current ID", () => {
  const first = { id: "first", path: "E:\\one\\a.zip" };
  const second = { id: "second", path: "D:\\two\\b.gif" };
  const batch = { requestId: "r1", currentId: "second", items: [first, second] };
  const target = navigation.externalExplorerTarget(batch);
  assert.equal(target.item, second);
  assert.equal(target.request.path, "D:\\two");
  assert.equal(target.request.requestId, "r1");
  assert.equal(navigation.externalExplorerTarget({ ...batch, currentId: "unknown" }).item, first);
  assert.equal(navigation.externalExplorerTarget({ ...batch, items: [] }), undefined);
});

test("Explorer back and forward preserve PC entries and discard a branched future", () => {
  let state = { back: [], forward: [] };
  state = navigation.navigateExplorer(state, "E:\\");
  state = navigation.navigateExplorer(state, "E:\\books");
  state = navigation.stepExplorer(state, "back");
  assert.equal(state.path, "E:\\");
  state = navigation.stepExplorer(state, "back");
  assert.equal(state.path, undefined);
  state = navigation.stepExplorer(state, "forward");
  assert.equal(state.path, "E:\\");
  state = navigation.navigateExplorer(state, "E:\\photos");
  assert.equal(state.forward.length, 0);
  navigation.rememberExplorerHistory(state);
  const restored = navigation.readExplorerHistory();
  assert.equal(restored.path, "E:\\photos");
  restored.back.push("mutated");
  assert.notEqual(navigation.readExplorerHistory().back.at(-1), "mutated");
  for (let index = 0; index < 200; index += 1) state = navigation.navigateExplorer(state, "E:\\" + index);
  assert.equal(state.back.length, 100);
});

test("App external-open callback navigates to the parent Explorer before publishing the catalog", () => {
  const source = ts.createSourceFile("App.tsx", read("src/App.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  const walk = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleExternalMediaOpen") declaration = node;
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(declaration);
  const calls = [];
  const callback = execute("module.exports = " + declaration.initializer.arguments[0].getText(source), {
    externalExplorerTarget: navigation.externalExplorerTarget,
    setExplorerNavigationRequest: (value) => calls.push(["location", value.path]),
    setExternalMediaBatch: (value) => calls.push(["file", value.currentId]),
    navigateToSection: (value) => calls.push(["section", value]),
    publishCatalogChange: () => calls.push(["refresh"]),
    setError: (value) => calls.push(["error", value]),
  });
  callback({ requestId: "r1", currentId: "file", items: [{ id: "file", path: "\\\\?\\E:\\本\\a.zip" }] });
  assert.deepEqual(calls, [["location", "\\\\?\\E:\\本"], ["file", "file"], ["section", "allFolders"], ["refresh"]]);
  const app = read("src/App.tsx");
  assert.ok(!app.includes("externalMediaBatch ? null : content()"), "folder remains mounted under viewer");
  assert.ok(app.includes("navigationRequest={explorerNavigationRequest}"));
  assert.ok(app.includes("openRequest={externalTarget ?"));
  assert.ok(read("src/components/FileSystemBrowser.tsx").includes("kinds={EXPLORER_MEDIA_KINDS}"), "stable kinds do not reset restored scrolling");
});
