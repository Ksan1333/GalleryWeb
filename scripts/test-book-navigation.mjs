import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/bookNavigation.ts", import.meta.url), "utf8");
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
const { bookSeekPosition, bookSeekKeyPage } = module.exports;

test("right binding progresses from right to left, including markers and preview", () => {
  assert.equal(bookSeekPosition(0, 101, "right"), 100);
  assert.equal(bookSeekPosition(25, 101, "right"), 75);
  assert.equal(bookSeekPosition(100, 101, "right"), 0);
  assert.equal(bookSeekPosition(25, 101, "left"), 25);
  assert.equal(bookSeekPosition(0, 0, "right"), 100);
  assert.equal(bookSeekPosition(9, 1, "left"), 0);
});

test("arrows and boundaries follow binding without reversing logical page numbers", () => {
  assert.equal(bookSeekKeyPage("ArrowLeft", 4, 20, "right"), 5);
  assert.equal(bookSeekKeyPage("ArrowRight", 4, 20, "right"), 3);
  assert.equal(bookSeekKeyPage("ArrowLeft", 4, 20, "left"), 3);
  assert.equal(bookSeekKeyPage("ArrowLeft", 4, 20, "right", 2), 6);
  assert.equal(bookSeekKeyPage("Home", 4, 20, "right"), 0);
  assert.equal(bookSeekKeyPage("End", 4, 20, "right"), 19);
  assert.equal(bookSeekKeyPage("ArrowRight", 0, 20, "right"), 0);
  assert.equal(bookSeekKeyPage("ArrowLeft", 19, 20, "right"), 19);
  assert.equal(bookSeekKeyPage("Tab", 4, 20, "right"), undefined);
});

test("book seek consumes its key events, and video slider remains independent", () => {
  const viewer = readFileSync(new URL("../src/components/MediaViewer.tsx", import.meta.url), "utf8");
  assert.ok(viewer.includes('dir={binding === "right" ? "rtl" : "ltr"}'));
  assert.ok(viewer.includes("bookSeekPosition(anchor, pageCount, binding)"));
  assert.ok(viewer.includes("bookSeekPosition(seekPreviewPage, pageCount, binding)"));
  assert.ok(viewer.includes("if (event.defaultPrevented) return;"));
  const video = viewer.slice(viewer.indexOf('className="pv-video-seek"'), viewer.indexOf("function BookViewer("));
  assert.ok(!video.includes("bookSeekKeyPage"));
  assert.ok(!video.includes('dir="rtl"'));
});
