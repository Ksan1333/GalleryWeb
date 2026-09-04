import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/MediaCollection.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("MediaCollection.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ["CachedMediaVisual", "SettledMediaPlaceholder"];
const extracted = functions.map((name) => {
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Missing production function: ${name}`);
  return declaration.getText(parsed);
}).join("\n");
const compiled = ts.transpileModule(`${extracted}\nexport { ${functions.join(", ")} };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Exercise production branching/callbacks, mocking only thumbnail I/O, hooks,
// and heavyweight child renderers. This never starts a browser or reads media.
function harness({ cachedSource, lookupPending = false, sourceUrl = "original://media" } = {}) {
  const state = { cachedSource, lookupPending, sourceUrl, settled: 0, capturedElements: [], capturedData: [], failures: [], priorities: [], children: [] };
  const module = { exports: {} };
  const child = (name) => {
    const component = (props) => { state.children.push(name); return { type: name, props }; };
    return component;
  };
  const children = {
    ArchiveMediaVisual: child("archive-cover"),
    VideoThumbnail: child("video-frame"),
    PdfThumbnail: child("pdf-page"),
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (name) => {
      assert.equal(name, "react/jsx-runtime");
      const jsx = (type, props) => ({ type, props });
      return { jsx, jsxs: jsx };
    },
    useCallback: (callback) => callback,
    useEffect: (effect) => effect(),
    useCachedThumbnail: (_item, priority) => {
      state.priorities.push(priority);
      return {
        cachedSource: state.cachedSource,
        lookupPending: state.lookupPending,
        cacheElement: (element) => state.capturedElements.push(element),
        cacheDataUrl: (data) => state.capturedData.push(data),
      };
    },
    mediaAssetUrl: () => state.sourceUrl,
    reportMediaLoadFailure: async (id) => { state.failures.push(id); },
    Icon: child("icon"),
    ...children,
  });
  const onSettled = () => { state.settled += 1; };
  const render = (kind, priority = "visible") => module.exports.CachedMediaVisual({
    item: { id: `${kind}-id`, kind, name: `${kind}-name` },
    thumbnailPriority: priority,
    onSettled,
  });
  const mount = (node) => typeof node.type === "function" ? mount(node.type(node.props)) : node;
  return { state, children, render, mount, onSettled };
}

test("cached nearby thumbnails remain lazy img elements for every media kind", () => {
  for (const kind of ["image", "gif", "video", "pdf", "archive"]) {
    const h = harness({ cachedSource: "thumbnail://cached.webp" });
    const visual = h.mount(h.render(kind, "nearby"));
    assert.equal(visual.type, "img", kind);
    assert.equal(visual.props.src, "thumbnail://cached.webp", kind);
    assert.equal(visual.props.loading, "lazy", kind);
    assert.equal(visual.props.decoding, "async", kind);
    assert.deepEqual(h.state.children, [], kind);
    visual.props.onLoad();
    assert.equal(h.state.settled, 1, kind);
    assert.deepEqual(h.state.capturedElements, [], "cached thumbnails are not recaptured");
  }
});

test("uncached nearby/background media never mount full-size images, video, PDF, or ZIP fallbacks", () => {
  for (const priority of ["nearby", "background"]) {
    for (const kind of ["image", "gif", "video", "pdf", "archive"]) {
      const h = harness();
      const visual = h.mount(h.render(kind, priority));
      assert.equal(visual.type, "div", `${kind}/${priority}`);
      assert.match(visual.props.className, /media-placeholder/, `${kind}/${priority}`);
      assert.equal(visual.props.src, undefined, `${kind}/${priority}`);
      assert.deepEqual(h.state.children, [], `${kind}/${priority}`);
      assert.deepEqual(h.state.capturedElements, []);
      assert.deepEqual(h.state.capturedData, []);
      assert.deepEqual(h.state.failures, []);
      assert.equal(h.state.priorities.at(-1), priority);
    }
  }
});

test("an uncached image becoming visible starts its original-image fallback and releases on capture/error", () => {
  for (const kind of ["image", "gif"]) {
    const h = harness();
    assert.equal(h.mount(h.render(kind, "nearby")).type, "div");
    h.state.settled = 0;
    const visual = h.mount(h.render(kind, "visible"));
    assert.equal(visual.type, "img");
    assert.equal(visual.props.src, "original://media");
    assert.equal(visual.props.loading, "eager");
    assert.equal(visual.props.crossOrigin, "anonymous");
    const element = { tagName: "IMG" };
    visual.props.onLoad({ currentTarget: element });
    assert.deepEqual(h.state.capturedElements, [element]);
    assert.equal(h.state.settled, 1);
    visual.props.onError();
    assert.equal(h.state.settled, 2);
    assert.deepEqual(h.state.failures, [`${kind}-id`]);
  }
});

test("visible video and PDF fallbacks preserve source, capture, settled, and error callbacks", () => {
  for (const kind of ["video", "pdf"]) {
    const h = harness();
    assert.equal(h.mount(h.render(kind, "nearby")).type, "div");
    h.state.settled = 0;
    const visual = h.mount(h.render(kind));
    assert.equal(visual.type, kind === "video" ? "video-frame" : "pdf-page");
    assert.equal(visual.props.source, "original://media");
    assert.equal(visual.props.onSettled, h.onSettled);
    if (kind === "video") {
      const element = { tagName: "VIDEO" };
      visual.props.onFrameReady(element);
      assert.deepEqual(h.state.capturedElements, [element]);
    } else {
      visual.props.onRendered("data:image/jpeg;base64,fixture");
      assert.deepEqual(h.state.capturedData, ["data:image/jpeg;base64,fixture"]);
      assert.equal(visual.props.name, "pdf-name");
    }
    assert.equal(h.state.settled, 1);
    visual.props.onSourceError();
    assert.equal(h.state.settled, 2);
    assert.deepEqual(h.state.failures, [`${kind}-id`]);
  }
});

test("visible ZIP/CBZ fallback preserves cover capture and onSettled even without a direct asset URL", () => {
  const h = harness({ sourceUrl: undefined });
  h.state.sourceUrl = undefined;
  assert.equal(h.mount(h.render("archive", "nearby")).type, "div");
  h.state.settled = 0;
  const visual = h.mount(h.render("archive"));
  assert.equal(visual.type, "archive-cover");
  assert.equal(visual.props.item.id, "archive-id");
  assert.equal(visual.props.onSettled, h.onSettled);
  const element = { tagName: "IMG" };
  visual.props.onImageLoaded(element);
  assert.deepEqual(h.state.capturedElements, [element]);
  assert.equal(h.state.settled, 1);
  visual.props.onSettled();
  assert.equal(h.state.settled, 2);
});

test("pending lookups still wait and unsupported/missing visible media still settle their decoder slot", () => {
  for (const kind of ["image", "video", "pdf", "archive"]) {
    const h = harness({ lookupPending: true });
    const visual = h.mount(h.render(kind));
    assert.equal(visual.type, "div");
    assert.deepEqual(h.state.children, []);
    assert.equal(h.state.settled, 0, "pending lookup must not start or finish a fallback");
  }
  for (const kind of ["image", "video", "pdf", "document"]) {
    const h = harness();
    h.state.sourceUrl = undefined;
    const visual = h.mount(h.render(kind));
    assert.equal(visual.type, "div");
    assert.equal(h.state.settled, 1, `${kind}: terminal placeholder releases the slot`);
    assert.deepEqual(h.state.children, []);
  }
});
