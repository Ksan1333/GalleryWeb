import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const viewer = readFileSync(new URL("../src/components/MediaViewer.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("MediaViewer.tsx", viewer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && ["archivePageCacheKey", "getCachedArchivePageSource"].includes(node.name?.text)).map((node) => node.getText(ast));
const code = ts.transpileModule(`const archivePageSourceCache = new Map<string, Promise<string>>();\n${functions.join("\n")}\nexports.getPage = getCachedArchivePageSource;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test("archive paths deduplicate in-flight only and revalidate after disk eviction", async () => {
  const module = { exports: {} };
  let calls = 0;
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  vm.runInNewContext(code, {
    module, exports: module.exports,
    getArchiveBookPage: () => { calls += 1; return calls === 1 ? first : Promise.resolve({ data: "regenerated.png" }); },
    localAssetUrl: (path) => path,
  });
  const firstRequest = module.exports.getPage("book", "revision", 3);
  const secondRequest = module.exports.getPage("book", "revision", 3);
  assert.equal(calls, 1);
  resolveFirst({ data: "cached.png" });
  assert.equal(await firstRequest, "cached.png");
  assert.equal(await secondRequest, "cached.png");
  assert.equal(await module.exports.getPage("book", "revision", 3), "regenerated.png");
  assert.equal(calls, 2);
});

test("failed page resolution can be retried and component caches cannot bypass revalidation", async () => {
  const module = { exports: {} };
  let calls = 0;
  vm.runInNewContext(code, {
    module, exports: module.exports,
    getArchiveBookPage: async () => (++calls === 1 ? { error: "temporarily unavailable" } : { data: "page.png" }),
    localAssetUrl: (path) => path,
  });
  await assert.rejects(module.exports.getPage("book", "revision", 2), /temporarily unavailable/);
  assert.equal(await module.exports.getPage("book", "revision", 2), "page.png");
  assert.ok(viewer.includes('if (item.kind === "archive") return getCachedArchivePageSource(item.id, item.modifiedAt, bookPage);'));
  assert.ok(viewer.includes('if (item.kind === "archive") return getDisplayPageSource(bookPage);'));
});
