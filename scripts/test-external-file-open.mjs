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

test("native startup barrier and queue draining stay on a blocking worker without a thumbnail-index dependency", () => {
  const native = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const start = native.indexOf('async fn take_pending_external_media(');
  assert.ok(start > 0);
  const command = native.slice(start, native.indexOf('#[tauri::command]', start));
  const worker = command.indexOf('run_catalog_worker(');
  assert.ok(worker >= 0 && worker < command.indexOf('.take_pending_external_media()?'));
  assert.ok(!command.includes('attach_existing_thumbnail_paths'));
  assert.ok(native.includes('ExternalInputState::with_startup_pending('));
  assert.ok(native.includes('.finish_startup();'));
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
    initialDrains: 0,
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
    onInitialDrain: () => { state.initialDrains += 1; },
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
  assert.equal(current.state.initialDrains, 1);
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
  assert.equal(current.state.initialDrains, 0, "ordinary startup work waits until the first take completes");
  current.state.handler({ payload: { ignored: true } });
  release({ data: null, available: true });
  await settle();
  await settle();
  assert.equal(current.state.takes, 2);
  assert.equal(current.state.maxActiveTakes, 1);
  assert.equal(current.state.initialDrains, 1, "startup is released exactly once even for empty input");
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
  assert.equal(failed.state.initialDrains, 1, "failed event subscription must not block normal startup");
  failed.unmount();
});

test("failed initial queue retrieval releases ordinary startup rather than leaving it blank", async () => {
  const current = harness({responses:[() => Promise.reject(new Error('queue unavailable'))]});
  await settle();
  await settle();
  assert.equal(current.state.initialDrains, 1);
  assert.equal(current.opened.length, 0);
  assert.equal(current.errors.length, 1);
  current.unmount();
});

test("unmounted startup ignores delayed queue delivery and its ready callback", async () => {
  let release;
  const current = harness({responses:[() => new Promise(resolve => { release = resolve; })]});
  await settle();
  current.unmount();
  release({data:{requestId:'late', items:[media('one')], currentId:'one'}, available:true});
  await settle();
  assert.equal(current.opened.length, 0);
  assert.equal(current.state.initialDrains, 0);
});
