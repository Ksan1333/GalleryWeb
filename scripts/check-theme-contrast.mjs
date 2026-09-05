import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(resolve("src/services/theme.ts"), "utf8");
const themeModule = { exports: {} };
const emitted = new Map();
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  module: themeModule, exports: themeModule.exports,
  require: () => ({ getCurrentWindow: () => { throw new Error("No native calls in theme fixture"); } }),
  window: {},
  document: { documentElement: { dataset: {}, style: { setProperty: (key, value) => emitted.set(key, value) } } },
});

function namedPalette(name) {
  const block = source.match(new RegExp(`const ${name}: ThemePalette = \\{([\\s\\S]*?)\\n\\};`));
  if (!block) throw new Error(`${name} palette was not found`);
  const values = Object.fromEntries(
    [...block[1].matchAll(/(background|surface|text|muted|accent|danger|success|border): "(#[0-9a-f]{6})"/gi)]
      .map((match) => [match[1], match[2]]),
  );
  if (Object.keys(values).length !== 8) throw new Error(`${name} palette is incomplete`);
  return values;
}

const named = { DARK: namedPalette("DARK"), LIGHT: namedPalette("LIGHT") };
const presetPattern = /\{ id: "([^"]+)", label: "([^"]+)", palette: (DARK|LIGHT|palette\(([^)]*)\)) \}/g;
const presets = [...source.matchAll(presetPattern)].map((match) => {
  if (match[3] === "DARK" || match[3] === "LIGHT") return { id: match[1], ...named[match[3]] };
  const colors = [...match[4].matchAll(/"(#[0-9a-f]{6})"/gi)].map((color) => color[1]);
  if (colors.length !== 8) throw new Error(`${match[1]} must define eight colors`);
  return {
    id: match[1],
    ...Object.fromEntries(["background", "surface", "text", "muted", "accent", "danger", "success", "border"]
      .map((key, index) => [key, colors[index]])),
  };
});

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return channels.reduce((sum, channel, index) => {
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function contrast(left, right) {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

const failures = [];
if (presets.length !== 20) failures.push(`expected 20 Android-visible presets, found ${presets.length}`);
if (new Set(presets.map((preset) => preset.id)).size !== presets.length) failures.push("preset ids must be unique");

for (const preset of presets) {
  for (const [label, foreground, background, minimum] of [
    ["body text", preset.text, preset.background, 4.5],
    ["surface text", preset.text, preset.surface, 4.5],
    ["muted text", preset.muted, preset.background, 3.0],
  ]) {
    const ratio = contrast(foreground, background);
    if (ratio < minimum) failures.push(`${preset.id} ${label}: ${ratio.toFixed(2)} < ${minimum}`);
  }
  themeModule.exports.applyThemeSettings({ mode: "dark", preset: preset.id, custom: preset }, false);
  const bestAccentText = contrast(emitted.get("--accent"), emitted.get("--accent-contrast"));
  if (bestAccentText < 4.5) failures.push(`${preset.id} accent has no accessible text color`);
}

if (failures.length > 0) {
  console.error("Theme regression check failed:");
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Theme regression check passed: ${presets.length} presets, contrast and uniqueness verified.`);
}
