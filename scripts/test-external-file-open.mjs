import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/hooks/useExternalMediaOpen.ts", import.meta.url), "utf8");
const hookCode = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("App delegates external files to the Explorer collection viewer", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src/components/MediaViewer.tsx", import.meta.url), "utf8");
  assert.ok(app.includes("enabled: true"), "external input must not wait for full catalog summaries");
  assert.ok(!app.includes("externalMediaBatch ? null : content()"), "the parent folder stays mounted behind its viewer");
  assert.ok(app.includes("openRequest={externalTarget ?"), "external files open through their folder collection");
  assert.ok(app.includes("aiAnalysisPanelRequest && !externalMediaBatch"), "other modal input handlers must be suspended");
  assert.ok(app.includes("backgroundUiReady && !externalMediaBatch"), "the first-run focus trap must be suspended");
  assert.ok(viewer.includes("if (preserveItemOrder) return items"));
});

function media(id) {
  return {
    id,
    path: `C:\\Media\\${id}.webp`,
    name: `${id}.webp`,
    kind: "image",
    sizeBytes: 1,
    isFavorite: false,
    ageRating: "UNRATED",
    tags: [],
  };
}

function harness({ responses = [], listenError } = {}) {
  const effects = [];
  const opened = [];
  const errors = [];
  const state = {
    handler: undefined,
    takes: 0,
    activeTakes: 0,
    maxActiveTakes: 0,
    unlistened: 0,
  };
  const module = { exports: {} };
  vm.runInNewContext(hookCode, {
    exports: module.exports,
    module,
    require: (name) => {
      if (name === "react") return {
        useEffect: (effect) => effects.push(effect),
        useRef: (current) => ({ current }),
      };
      if (name === "@tauri-apps/api/event") return {
        listen: (_event, handler) => {
          state.handler = handler;
          return listenError
            ? Promise.reject(listenError)
            : Promise.resolve(() => { state.unlistened += 1; });
        },
      };
      if (name === "../services/native") return {
        isTauriRuntime: () => true,
        takePendingExternalMedia: async () => {
          state.takes += 1;
          state.activeTakes += 1;
          state.maxActiveTakes = Math.max(state.maxActiveTakes, state.activeTakes);
          try {
            const response = responses.shift();
            return typeof response === "function" ? await response() : response ?? {
              data: null, available: true,
            };
          } finally {
            state.activeTakes -= 1;
          }
        },
      };
      return require(name);
    },
    setImmediate,
  });
  module.exports.useExternalMediaOpen({
    enabled: true,
    onOpen: (batch) => opened.push(batch),
    onError: (message) => errors.push(message),
  });
  const cleanups = effects.map((effect) => effect());
  return {
    state,
    opened,
    errors,
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
}

test("subscribes before draining startup input and repairs an invalid current id", async () => {
  const first = media("first");
  const current = harness({
    responses: [{
      data: { requestId: "startup", items: [first], currentId: "missing" },
      available: true,
    }],
  });
  await settle();
  await settle();
  assert.equal(current.state.takes, 1);
  assert.equal(current.opened.length, 1);
  assert.equal(current.opened[0].currentId, first.id);
  current.unmount();
  assert.equal(current.state.unlistened, 1);
});

test("coalesces events while a take is pending and never drains concurrently", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const current = harness({
    responses: [
      () => pending,
      { data: null, available: true },
    ],
  });
  await settle();
  current.state.handler({ payload: { ignored: true } });
  current.state.handler({ payload: { ignored: true } });
  release({ data: null, available: true });
  await settle();
  await settle();
  assert.equal(current.state.takes, 2);
  assert.equal(current.state.maxActiveTakes, 1);
  current.unmount();
});

test("deduplicates request ids and still drains startup input if listen fails", async () => {
  const batch = { requestId: "same", items: [media("one")], currentId: "one" };
  const current = harness({
    responses: [
      { data: batch, available: true },
      { data: batch, available: true },
    ],
  });
  await settle();
  await settle();
  current.state.handler({ payload: null });
  await settle();
  await settle();
  assert.equal(current.opened.length, 1);
  current.unmount();

  const failed = harness({
    listenError: new Error("listen unavailable"),
    responses: [{ data: batch, available: true }],
  });
  await settle();
  await settle();
  assert.deepEqual(failed.errors, ["外部ファイルを受け取る準備ができませんでした。"]);
  assert.equal(failed.opened.length, 1);
  failed.unmount();
});
