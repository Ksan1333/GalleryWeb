// Execute production settings handlers against isolated API fixtures; no GUI,
// notifications, catalog writes, or real backup dialogs are used.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function handler(file, name, globals) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(matches.length, 1);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(`${matches[0].getText()}; module.exports = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, ...globals });
  return module.exports;
}

function generalHarness(write = async () => ({ available: true, data: true })) {
  const state = { preferences: { theme: "dark", themePalette: "default", nativeNotifications: true }, calls: [], events: [], loading: false, busy: false };
  const preferencesRef = { current: state.preferences };
  const busyRef = { current: false };
  const update = handler("src/components/GeneralSettings.tsx", "updatePreference", {
    nativeAvailable: true, loaded: true, loading: false, busyRef, preferencesRef,
    setBusy: (value) => { state.busy = value; }, setError: (value) => { state.error = value; },
    setMessage: (value) => { state.message = value; },
    setPreference: async (...args) => { state.calls.push(args); return write(...args); },
    setPreferences: (value) => { state.preferences = value; },
    announceThemePreferences: (value) => state.events.push(["theme", value]),
    configureNativeNotifications: (value) => state.events.push(["notifications", value]),
  });
  return { state, update };
}

test("general settings publish theme and notification changes only after a successful save", async () => {
  const failed = generalHarness(async () => ({ available: true, data: false, error: "disk full" }));
  await failed.update("theme", "light");
  assert.equal(failed.state.preferences.theme, "dark");
  assert.equal(failed.state.events.length, 0);
  assert.equal(failed.state.error, "disk full");
  assert.equal(failed.state.busy, false);
  const saved = generalHarness();
  await saved.update("nativeNotifications", false);
  assert.equal(saved.state.preferences.nativeNotifications, false);
  assert.equal(saved.state.events[0][0], "theme");
  assert.equal(saved.state.events[1][0], "notifications");
  assert.equal(saved.state.events[1][1], false);
});

test("settings reject overlapping saves before React can commit disabled controls", async () => {
  let finish;
  const { state, update } = generalHarness(() => new Promise((resolve) => { finish = resolve; }));
  const pending = update("theme", "light");
  await update("autoAnalyze", true);
  assert.equal(state.calls.length, 1);
  assert.equal(state.events.length, 0, "no optimistic runtime side effects");
  finish({ available: true, data: true });
  await pending;
  assert.equal(state.preferences.theme, "light");
  assert.equal(state.busy, false);
});

function diagnosticHarness(initial, responses = {}) {
  const state = { diagnostics: initial, calls: [] };
  const response = (name, fallback) => async () => {
    state.calls.push(name);
    return responses[name] ?? { available: true, data: fallback };
  };
  const run = handler("src/components/DiagnosticSettings.tsx", "runDiagnostic", {
    nativeAvailable: true, diagnostics: initial, busyRef: { current: false },
    setError: (value) => { state.error = value; }, setMessage: (value) => { state.message = value; },
    setBusy: (value) => { state.busy = value; }, setDiagnostics: (value) => { state.diagnostics = value; },
    setSnapshot: (value) => { state.snapshot = value; }, formatBytes: (value) => `${value} B`,
    getSystemDiagnostics: response("inspect", { status: "healthy" }),
    optimizeCatalog: response("optimize", { status: "healthy" }),
    exportDiagnosticsReport: response("export", { path: "fixture.json", bytes: 20 }),
    createCatalogRecoverySnapshot: response("snapshot", { path: "fixture.db", bytes: 20, sha256: "checksum" }),
  });
  return { state, run };
}

test("diagnostics block maintenance and snapshots before checks and when issues are present", async () => {
  for (const initial of [undefined, { status: "issues" }]) {
    const { state, run } = diagnosticHarness(initial);
    await run("optimize");
    await run("snapshot");
    assert.deepEqual(state.calls, []);
    assert.match(state.error, /先に整合性/);
    await run("export");
    assert.deepEqual(state.calls, ["export"], "problem reports remain exportable");
  }
});

test("healthy diagnostics allow a verified snapshot and failures invalidate stale healthy status", async () => {
  const healthy = diagnosticHarness({ status: "healthy" });
  await healthy.run("snapshot");
  assert.equal(healthy.state.snapshot.sha256, "checksum");
  const failed = diagnosticHarness({ status: "healthy" }, {
    optimize: { available: true, error: "integrity changed" },
  });
  await failed.run("optimize");
  assert.equal(failed.state.diagnostics, undefined);
  assert.equal(failed.state.error, "integrity changed");
  assert.equal(failed.state.busy, undefined);
});

function restoreHarness(importResponse, preferenceResponse) {
  const state = { events: [] };
  const restore = handler("src/components/DataPortabilitySettings.tsx", "importBackup", {
    setError: (value) => { state.error = value; }, setMessage: (value) => { state.message = value; },
    setBusy: (value) => { state.busy = value; },
    importSettingsBackup: async () => importResponse,
    getPreferences: async () => preferenceResponse,
    announceThemePreferences: (value) => state.events.push(["theme", value]),
    configureNativeNotifications: (value) => state.events.push(["notifications", value]),
    onDataChanged: () => state.events.push(["refresh"]),
  });
  return { state, restore };
}
test("restored backup applies refreshed appearance and notification preferences immediately", async () => {
  const preferences = { theme: "light", nativeNotifications: false };
  const { state, restore } = restoreHarness({ available: true, data: { preferences: 12 } }, { available: true, data: preferences });
  await restore();
  assert.equal(state.events[0][0], "theme");
  assert.equal(state.events[0][1], preferences);
  assert.deepEqual(state.events[1], ["notifications", false]);
  assert.equal(state.events[2][0], "refresh");
  assert.equal(state.busy, false);
});

test("backup cancellation does not announce defaults, and post-import refresh failure is explicit", async () => {
  const canceled = restoreHarness({ available: true, data: null });
  await canceled.restore();
  assert.equal(canceled.state.events.length, 0);
  assert.equal(canceled.state.busy, false);
  const failed = restoreHarness({ available: true, data: { preferences: 12 } }, { available: true, error: "read failed" });
  await failed.restore();
  assert.equal(failed.state.events.length, 1);
  assert.equal(failed.state.events[0][0], "refresh");
  assert.match(failed.state.error, /設定は復元しましたが/);
  assert.equal(failed.state.busy, false);
});

const nativeCode = ts.transpileModule(readFileSync(new URL("../src/services/native.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function preferenceCacheHarness() {
  const state = { values: { theme: "dark", nativeNotifications: true }, reads: [], importMode: "success", writeFailure: false };
  const module = { exports: {} };
  vm.runInNewContext(nativeCode, {
    module, exports: module.exports, window: { __TAURI_INTERNALS__: {} },
    require: (name) => {
      if (name === "../appVersion") return { APP_VERSION: "fixture" };
      if (name !== "@tauri-apps/api/core") throw new Error(`Unexpected native fixture import ${name}`);
      return { convertFileSrc: (value) => value, invoke: async (command, args) => {
        if (command === "get_preferences") {
          const snapshot = structuredClone(state.values);
          return new Promise((resolve) => state.reads.push({
            resolve: () => resolve(Object.entries(snapshot).map(([key, value]) => ({ key, value }))),
          }));
        }
        if (command === "import_settings_backup") {
          if (state.importMode === "fail") throw new Error("import failed");
          if (state.importMode === "cancel") return null;
          state.values = { theme: "light", nativeNotifications: false };
          return { path: "fixture.json", preferences: 2 };
        }
        if (command === "set_preference") {
          if (state.writeFailure) throw new Error("write failed");
          state.values = { ...state.values, [args.key]: args.value };
          return null;
        }
        throw new Error(`Unexpected native command ${command}`);
      } };
    },
  });
  return { state, api: module.exports };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("backup import detaches old preference reads and both old/new callers receive restored values", async () => {
  const { state, api } = preferenceCacheHarness();
  const oldRead = api.getPreferences();
  assert.equal(state.reads.length, 1);
  await api.importSettingsBackup();
  const newRead = api.getPreferences();
  assert.equal(state.reads.length, 2, "post-import callers do not join the pre-import snapshot");
  state.reads[0].resolve();
  await tick();
  assert.equal(state.reads.length, 2, "stale readers join the one fresh request");
  state.reads[1].resolve();
  const [before, after] = await Promise.all([oldRead, newRead]);
  assert.equal(before.data.theme, "light", "old callers cannot reapply stale appearance");
  assert.equal(after.data.nativeNotifications, false);
  assert.equal((await api.getPreferences()).data.theme, "light");
  assert.equal(state.reads.length, 2, "fresh results remain cached");
});

test("a late pre-import read cannot overwrite an already completed restored snapshot", async () => {
  const { state, api } = preferenceCacheHarness();
  const oldRead = api.getPreferences();
  await api.importSettingsBackup();
  const fresh = api.getPreferences();
  state.reads[1].resolve();
  assert.equal((await fresh).data.theme, "light");
  state.reads[0].resolve();
  assert.equal((await oldRead).data.theme, "light");
  assert.equal((await api.getPreferences()).data.theme, "light");
  assert.equal(state.reads.length, 2);
});

test("canceled/failed imports and failed writes preserve valid in-flight preference requests", async () => {
  for (const mode of ["cancel", "fail"]) {
    const { state, api } = preferenceCacheHarness();
    const before = api.getPreferences();
    state.importMode = mode;
    await api.importSettingsBackup();
    state.writeFailure = true;
    await api.setPreference("theme", "light");
    const after = api.getPreferences();
    assert.equal(state.reads.length, 1);
    state.reads[0].resolve();
    assert.equal((await before).data.theme, "dark");
    assert.equal((await after).data.theme, "dark");
  }
});

test("scalar/JSON writes invalidate pending reads while preserving warm-cache patch efficiency", async () => {
  for (const json of [false, true]) {
    const { state, api } = preferenceCacheHarness();
    const pending = api.getPreferences();
    if (json) await api.setJsonPreference("galleryDisplayPreferences", { gridSize: "maximum" });
    else await api.setPreference("theme", "light");
    state.reads[0].resolve();
    await tick();
    assert.equal(state.reads.length, 2, "a read started before a successful write is reissued");
    state.reads[1].resolve();
    const value = (await pending).data;
    if (json) assert.equal(value.galleryDisplayPreferences.gridSize, "maximum");
    else assert.equal(value.theme, "light");
    await api.setPreference("nativeNotifications", false);
    assert.equal((await api.getPreferences()).data.nativeNotifications, false);
    assert.equal(state.reads.length, 2, "a populated cache is patched without an extra full read");
  }
});
