import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/thumbnailCoordinator.ts", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Execute the real coordinator with deterministic scheduling and native I/O.
// No browser, media files, GPU, or application user data are involved.
function harness({ code = source, batch, single, animationFrames = true } = {}) {
  const counters = { notifications: 0, cacheScans: 0, active: 0, maxActive: 0 };
  const microtasks = [];
  const timers = [];
  const frames = [];
  const batches = [];
  const singles = [];
  const nativeListeners = new Map();
  const browserListeners = new Map();
  let now = 10_000;
  let mounting;
  const module = { exports: {} };
  class TrackedMap extends Map {
    values() {
      if (this.size > 4_096) counters.cacheScans += 1;
      return super.values();
    }
  }
  const output = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, {
    exports: module.exports, module, Map: TrackedMap,
    Date: class extends Date { static now() { return now; } },
    queueMicrotask: (callback) => microtasks.push(callback),
    setTimeout: (callback) => timers.push(callback),
    requestAnimationFrame: animationFrames ? (callback) => frames.push(callback) : undefined,
    window: { addEventListener: (name, callback) => browserListeners.set(name, callback) },
    require: (name) => {
      if (name === "react") return {
        useCallback: (callback) => callback,
        useEffect: (effect) => mounting.effects.push(effect),
        useSyncExternalStore: (subscribe, getSnapshot) => {
          const card = mounting;
          card.snapshot = getSnapshot;
          card.unsubscribe = subscribe(() => {
            card.notifications += 1;
            counters.notifications += 1;
            card.observed = getSnapshot();
          });
          card.observed = getSnapshot();
          return card.observed;
        },
      };
      if (name === "@tauri-apps/api/event") return {
        listen: async (name, callback) => { nativeListeners.set(name, callback); return () => {}; },
      };
      if (name === "./native") return {
        isTauriRuntime: () => true,
        mediaThumbnailResolvedEvent: "thumbnail-resolved",
        getMediaThumbnails: async (ids) => {
          batches.push([...ids]);
          counters.active += 1;
          counters.maxActive = Math.max(counters.maxActive, counters.active);
          try {
            await Promise.resolve();
            return batch ? await batch([...ids]) : {
              available: true,
              data: ids.map((mediaId) => ({ mediaId, thumbnailPath: `${mediaId}.webp` })),
            };
          } finally { counters.active -= 1; }
        },
        getMediaThumbnail: async (id) => {
          singles.push(id);
          return single ? single(id) : { available: true, data: `${id}.webp` };
        },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const api = module.exports;
  const flushMicrotasks = () => {
    let count = 0;
    while (microtasks.length) {
      assert.ok(count++ < 10_000, "microtask queue must be bounded");
      microtasks.shift()();
    }
  };
  const flushFrames = () => frames.splice(0).forEach((callback) => callback(now));
  const tick = async () => {
    for (let wave = 0; wave < 100; wave += 1) {
      flushMicrotasks();
      await settle();
      if (!microtasks.length) return;
    }
    throw new Error("microtasks did not yield");
  };
  const drain = async () => {
    for (let turn = 0; turn < 200; turn += 1) {
      await tick();
      flushFrames();
      if (!microtasks.length && !timers.length && !frames.length) return;
      timers.splice(0).forEach((callback) => callback());
    }
    throw new Error("coordinator did not become idle");
  };
  return {
    api, counters, batches, singles, tick, drain, flushFrames,
    pendingWork: () => microtasks.length + timers.length + frames.length,
    advance: (ms) => { now += ms; },
    resolved: (id, path) => nativeListeners.get("media-thumbnail-resolved")({ payload: { mediaId: id, thumbnailPath: path } }),
    browserResolved: (id, path) => browserListeners.get("thumbnail-resolved")({ detail: { mediaId: id, path } }),
    mount: (id, { revision = "revision-1", knownPath, priority = "visible" } = {}) => {
      const card = { effects: [], notifications: 0 };
      mounting = card;
      api.useCoordinatedThumbnail(id, revision, knownPath, priority);
      const cleanups = card.effects.map((effect) => effect());
      mounting = undefined;
      card.unmount = () => { card.unsubscribe(); cleanups.forEach((cleanup) => cleanup?.()); };
      return card;
    },
  };
}

const targets = (count, priority = "visible", prefix = "item") => Array.from(
  { length: count }, (_, index) => ({ mediaId: `${prefix}-${index}`, revision: "revision-1", priority }),
);

test("16 cached replies notify each mounted card once, rather than queued/loading/ready separately", async () => {
  const h = harness();
  const cards = targets(16).map(({ mediaId }) => h.mount(mediaId));
  await h.tick();
  assert.equal(h.counters.notifications, 0, "snapshots should be coalesced until paint");
  assert.ok(cards.every((card) => card.snapshot().status === "ready"), "current state remains immediately readable");
  h.flushFrames();
  assert.equal(h.counters.notifications, 16);
  assert.ok(cards.every((card) => card.notifications === 1 && card.observed.status === "ready"));
  cards.forEach((card) => card.unmount());
});

test("cached batches yield to the event loop and retain the 2 by 8 concurrency cap", async () => {
  const h = harness();
  const release = h.api.prefetchThumbnails(targets(96));
  await h.tick();
  assert.equal(h.batches.length, 2, "only the initial 16 items may start before the next event-loop turn");
  assert.equal(h.counters.maxActive, 2);
  await h.drain();
  assert.equal(h.batches.length, 12);
  assert.ok(h.batches.every((ids) => ids.length <= 8));
  assert.equal(new Set(h.batches.flat()).size, 96);
  release();
});

test("visible work wins over prefetch and released offscreen queued work never crosses IPC", async () => {
  const h = harness();
  const releaseBackground = h.api.prefetchThumbnails(targets(32, "background", "offscreen"));
  const visible = [h.mount("visible-a"), h.mount("visible-b")];
  await h.tick();
  assert.deepEqual(h.batches[0].slice(0, 2), ["visible-a", "visible-b"]);
  releaseBackground();
  await h.drain();
  assert.equal(h.batches.length, 2, "unstarted offscreen lookups must be dropped");
  visible.forEach((card) => card.unmount());
});

test("duplicate leases share work, and native/browser completions cannot be overwritten by a stale batch", async () => {
  let finish;
  const h = harness({ batch: () => new Promise((resolve) => { finish = resolve; }) });
  const card = h.mount("image");
  const release = h.api.prefetchThumbnails([
    { mediaId: "image", revision: "revision-1", priority: "background" },
    { mediaId: "image", revision: "revision-1", priority: "visible" },
  ]);
  await h.tick();
  assert.deepEqual(h.batches, [["image"]]);
  h.resolved("image", "native.webp");
  h.browserResolved("image", "saved.webp");
  finish({ available: true, data: [{ mediaId: "image", thumbnailPath: null }] });
  await h.drain();
  assert.equal(card.snapshot().path, "saved.webp");
  assert.equal(card.observed.path, "saved.webp");
  card.unmount();
  release();
});

test("older native builds retain bounded single-file fallback for images, videos, PDF, ZIP and errors", async () => {
  let active = 0;
  let maxActive = 0;
  const h = harness({
    batch: async () => { throw new Error("command unavailable"); },
    single: async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await settle();
      active -= 1;
      if (id === "error") throw new Error("unreadable file");
      return { available: true, data: id === "missing" ? null : `${id}.webp` };
    },
  });
  const cards = new Map(["image", "video", "pdf", "zip", "missing", "error"].map((id) => [id, h.mount(id)]));
  // The fixture's fallback intentionally spans several native turns.
  for (let turn = 0; turn < 12; turn += 1) await h.tick();
  await h.drain();
  assert.equal(maxActive, 2);
  for (const id of ["image", "video", "pdf", "zip"]) assert.equal(cards.get(id).snapshot().path, `${id}.webp`);
  assert.equal(cards.get("missing").snapshot().status, "missing");
  assert.equal(cards.get("error").snapshot().status, "error");
  cards.forEach((card) => card.unmount());
});

test("missing lookups remain retryable after the existing three-second backoff", async () => {
  const h = harness({ batch: async (ids) => ({ available: true, data: ids.map((mediaId) => ({ mediaId, thumbnailPath: null })) }) });
  let card = h.mount("missing");
  await h.drain();
  assert.equal(card.snapshot().status, "missing");
  card.unmount();
  card = h.mount("missing");
  await h.drain();
  assert.equal(h.batches.length, 1);
  card.unmount();
  h.advance(3_001);
  card = h.mount("missing");
  await h.drain();
  assert.equal(h.batches.length, 2);
  card.unmount();
});

test("known-path bursts do not schedule empty lookup pumps, and cache pruning is coalesced", async () => {
  const h = harness();
  for (let index = 0; index < 5_000; index += 1) {
    h.api.seedCoordinatedThumbnail(`seed-${index}`, "revision-1", `${index}.webp`);
  }
  await h.drain();
  assert.equal(h.counters.cacheScans, 1, "one prune for the whole 5,000-item burst");
  const evicted = h.mount("seed-100");
  const retained = h.mount("seed-4999");
  assert.equal(evicted.snapshot().status, "queued", "oldest unleased cache entries are still evicted");
  assert.equal(retained.snapshot().path, "4999.webp");
  evicted.unmount();
  retained.unmount();
  await h.drain();
  assert.equal(h.batches.length, 0);
  const known = harness();
  const release = known.api.prefetchThumbnails(targets(128).map((target) => ({ ...target, knownPath: `${target.mediaId}.webp` })));
  assert.equal(known.pendingWork(), 0, "ready-only prefetch must not schedule an empty lookup pump");
  release();
  await known.drain();
});

test("a subscribed cache entry survives pruning and browser-preview batches use the single lookup fallback", async () => {
  const h = harness({ batch: async () => ({ available: false, data: [] }) });
  const mounted = h.mount("keep", { knownPath: "keep.webp" });
  for (let index = 0; index < 4_200; index += 1) h.api.seedCoordinatedThumbnail(`seed-${index}`, "revision-1", `${index}.webp`);
  await h.drain();
  assert.equal(mounted.snapshot().path, "keep.webp");
  const preview = h.mount("preview");
  await h.drain();
  assert.deepEqual(h.singles, ["preview"]);
  assert.equal(preview.snapshot().path, "preview.webp");
  mounted.unmount();
  preview.unmount();
});

test("unmounted subscribers are not notified and environments without animation frames still settle", async () => {
  const h = harness({ animationFrames: false });
  const unmounted = h.mount("closed");
  const remaining = h.mount("open");
  unmounted.unmount();
  await h.drain();
  assert.equal(unmounted.notifications, 0);
  assert.equal(remaining.observed.status, "ready");
  remaining.unmount();
});

// Optional pre-commit comparison against the unchanged HEAD implementation.
// Run `node scripts/test-thumbnail-coordinator.mjs --compare-head` while editing.
if (process.argv.includes("--compare-head")) {
  const baseline = execFileSync("git", ["show", "HEAD:src/services/thumbnailCoordinator.ts"], {
    cwd: new URL("../", import.meta.url), encoding: "utf8",
  });
  const measure = async (code) => {
    const h = harness({ code });
    const cards = targets(16).map(({ mediaId }) => h.mount(mediaId));
    await h.drain();
    const notifications = h.counters.notifications;
    cards.forEach((card) => card.unmount());
    const scheduler = harness({ code });
    scheduler.api.prefetchThumbnails(targets(96));
    await scheduler.tick();
    const batchesBeforeYield = scheduler.batches.length;
    const cache = harness({ code });
    for (let index = 0; index < 5_000; index += 1) cache.api.seedCoordinatedThumbnail(`seed-${index}`, "revision-1", `${index}.webp`);
    await cache.drain();
    return { notificationsFor16Cards: notifications, batchesBeforeYield, cacheScansFor5000Seeds: cache.counters.cacheScans };
  };
  console.log("Coordinator deterministic call-count comparison:", JSON.stringify({ before: await measure(baseline), after: await measure(source) }));
}
