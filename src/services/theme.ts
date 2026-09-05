import { getCurrentWindow } from "@tauri-apps/api/window";

import type { UserPreferences } from "./native";

export type ThemeMode = "system" | "dark" | "light";
export type ThemePresetId =
  | "default"
  | "midnight"
  | "paper"
  | "sunrise"
  | "sunset"
  | "gorgeous"
  | "calm"
  | "spring"
  | "summer"
  | "winter"
  | "forest"
  | "neon"
  | "deepSea"
  | "coffee"
  | "sakuraMist"
  | "freshLeaf"
  | "porcelain"
  | "autumnLeaf"
  | "jewel"
  | "lilac"
  | "aqua"
  | "custom";

export type ThemePalette = {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  danger: string;
  success: string;
  border: string;
};

export type ThemeSettings = {
  mode: ThemeMode;
  preset: ThemePresetId;
  custom: ThemePalette;
};

export const THEME_CHANGED_EVENT = "pixvault:theme-settings-changed";
const CACHE_KEY = "pixvault-theme-settings-v1";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const DARK: ThemePalette = {
  background: "#0c0912",
  surface: "#121019",
  text: "#f7f4ff",
  muted: "#a7a1b2",
  accent: "#a77bf3",
  danger: "#ff7189",
  success: "#67dda8",
  border: "#30283a",
};

const LIGHT: ThemePalette = {
  background: "#f7f5fa",
  surface: "#ffffff",
  text: "#201b26",
  muted: "#665e70",
  accent: "#7650b5",
  danger: "#c83f58",
  success: "#25865a",
  border: "#ddd7e5",
};

type ThemePreset = {
  id: Exclude<ThemePresetId, "default" | "custom">;
  label: string;
  palette: ThemePalette;
};

function palette(
  background: string,
  surface: string,
  text: string,
  muted: string,
  accent: string,
  danger: string,
  success: string,
  border: string,
): ThemePalette {
  return { background, surface, text, muted, accent, danger, success, border };
}

export const themePresets: readonly ThemePreset[] = [
  { id: "midnight", label: "ミッドナイト", palette: DARK },
  { id: "paper", label: "ペーパー", palette: LIGHT },
  { id: "sunrise", label: "サンライズ", palette: palette("#fff7ed", "#fffbf5", "#2d1b16", "#6f4a3e", "#e65f3c", "#d6384d", "#2d9a68", "#ddd6d1") },
  { id: "sunset", label: "サンセット", palette: palette("#171018", "#241525", "#fff2e8", "#e0bbaa", "#ff8a3d", "#ff6175", "#62d58e", "#4a3d4a") },
  { id: "gorgeous", label: "ゴージャス", palette: palette("#100b12", "#1a121d", "#fff7e2", "#e8d2a0", "#ffc857", "#ff6678", "#5ddd9b", "#594d36") },
  { id: "calm", label: "カーム", palette: palette("#121715", "#17201d", "#eff8f2", "#c3d5ca", "#8fd19e", "#ff7480", "#67d695", "#35433d") },
  { id: "spring", label: "スプリング", palette: palette("#fff7fb", "#ffffff", "#25151d", "#69485a", "#e85d93", "#d83a55", "#2ba86b", "#ded8db") },
  { id: "summer", label: "サマー", palette: palette("#f1fbff", "#ffffff", "#0c2430", "#315d6e", "#00a7c8", "#d93a4e", "#149b70", "#d6e1e5") },
  { id: "winter", label: "ウィンター", palette: palette("#0e141b", "#141d27", "#f2faff", "#c5d8e6", "#8ed8ff", "#ff7180", "#64d69a", "#33414e") },
  { id: "forest", label: "フォレスト", palette: palette("#0f1711", "#172119", "#f0f8ef", "#c6d8c1", "#7acb6a", "#ff746f", "#6fda83", "#344236") },
  { id: "neon", label: "ネオン", palette: palette("#090b12", "#10131f", "#f1fff9", "#b8f7e6", "#49f2c2", "#ff4d8a", "#6dff85", "#28584f") },
  { id: "deepSea", label: "ディープシー", palette: palette("#071218", "#0d1d25", "#e9fcff", "#b5dce3", "#38c6d9", "#ff6576", "#58d899", "#24515a") },
  { id: "coffee", label: "コーヒー", palette: palette("#15100c", "#211811", "#f4e7d8", "#e2c4a0", "#d7a86e", "#ff6b70", "#75d18e", "#4a3d30") },
  { id: "sakuraMist", label: "サクラミスト", palette: palette("#fff4f8", "#fffbfd", "#2d1821", "#704b5a", "#d95f8d", "#d94359", "#2f9e71", "#e0d7db") },
  { id: "freshLeaf", label: "フレッシュリーフ", palette: palette("#f5fff2", "#ffffff", "#142314", "#3f633f", "#3fa35b", "#d94050", "#1d9b5a", "#d9e2d7") },
  { id: "porcelain", label: "ポーセリン", palette: palette("#f8fafc", "#ffffff", "#17202a", "#4b5e72", "#527aa3", "#d83e50", "#218f62", "#d9dfe5") },
  { id: "autumnLeaf", label: "オータムリーフ", palette: palette("#fff8f0", "#fffcf8", "#2b1a11", "#6b4936", "#c65a2e", "#d33e4e", "#2c955f", "#e5d6c9") },
  { id: "jewel", label: "ジュエル", palette: palette("#0b0a12", "#151326", "#fff4ff", "#e2c4ff", "#ff4fd8", "#ff667b", "#65e2a0", "#46334d") },
  { id: "lilac", label: "ライラック", palette: palette("#f9f5ff", "#ffffff", "#21182e", "#655777", "#8b6bd6", "#d84a5e", "#2a9766", "#ded6e9") },
  { id: "aqua", label: "アクア", palette: palette("#f1fbfc", "#ffffff", "#10272b", "#3c6269", "#2497a6", "#d64a5a", "#1f9568", "#d3e2e4") },
] as const;

const presetIds = new Set<ThemePresetId>([
  "default",
  "custom",
  ...themePresets.map((item) => item.id),
]);

function validColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : fallback;
}

function validMode(value: unknown): ThemeMode {
  return value === "system" || value === "light" ? value : "dark";
}

function validPreset(value: unknown): ThemePresetId {
  return typeof value === "string" && presetIds.has(value as ThemePresetId)
    ? value as ThemePresetId
    : "default";
}

export function themeSettingsFromPreferences(
  preferences: Pick<UserPreferences,
    | "theme"
    | "themePalette"
    | "themeBackground"
    | "themeSurface"
    | "themeText"
    | "themeMuted"
    | "themeAccent"
    | "themeDanger"
    | "themeSuccess"
    | "themeBorder"
  >,
): ThemeSettings {
  return {
    mode: validMode(preferences.theme),
    preset: validPreset(preferences.themePalette),
    custom: {
      background: validColor(preferences.themeBackground, DARK.background),
      surface: validColor(preferences.themeSurface, DARK.surface),
      text: validColor(preferences.themeText, DARK.text),
      muted: validColor(preferences.themeMuted, DARK.muted),
      accent: validColor(preferences.themeAccent, DARK.accent),
      danger: validColor(preferences.themeDanger, DARK.danger),
      success: validColor(preferences.themeSuccess, DARK.success),
      border: validColor(preferences.themeBorder, DARK.border),
    },
  };
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  return channels.reduce((sum, channel, index) => {
    const linear = channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

export function contrastRatio(foreground: string, background: string): number {
  const left = relativeLuminance(foreground);
  const right = relativeLuminance(background);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

export function accentForeground(accent: string): string {
  const dark = contrastRatio("#151119", accent);
  const light = contrastRatio("#ffffff", accent);
  if (dark >= 4.5 && dark >= light) return "#151119";
  if (light >= 4.5) return "#ffffff";
  // Near the mid-luminance boundary the tinted dark color can fail both
  // choices. Pure black provides the required contrast there.
  return "#000000";
}

function selectedPalette(settings: ThemeSettings): ThemePalette {
  if (settings.preset === "custom") return settings.custom;
  if (settings.preset !== "default") {
    return themePresets.find((item) => item.id === settings.preset)?.palette ?? DARK;
  }
  const dark = settings.mode === "dark"
    || (settings.mode === "system" && systemPrefersDark());
  return dark ? DARK : LIGHT;
}

let currentSettings: ThemeSettings | undefined;

export function applyThemeSettings(settings: ThemeSettings, cache = true): void {
  currentSettings = settings;
  const colors = selectedPalette(settings);
  const appearance = relativeLuminance(colors.background) > 0.48 ? "light" : "dark";
  const root = document.documentElement;
  root.dataset.theme = appearance;
  root.dataset.themePreset = settings.preset;
  root.style.colorScheme = appearance;
  root.style.setProperty("--bg", colors.background);
  root.style.setProperty("--panel", colors.surface);
  root.style.setProperty("--panel-raised", `color-mix(in srgb, ${colors.surface} 90%, ${colors.text})`);
  root.style.setProperty("--text", colors.text);
  root.style.setProperty("--muted", colors.muted);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-contrast", accentForeground(colors.accent));
  root.style.setProperty("--accent-strong", `color-mix(in srgb, ${colors.accent} 76%, ${appearance === "dark" ? "white" : "black"})`);
  root.style.setProperty("--danger", colors.danger);
  root.style.setProperty("--success", colors.success);
  root.style.setProperty("--border", colors.border);
  root.style.setProperty("--sidebar-bg", `color-mix(in srgb, ${colors.surface} 96%, ${colors.background})`);
  root.style.setProperty("--field-bg", `color-mix(in srgb, ${colors.surface} 86%, ${colors.background})`);
  root.style.setProperty("--accent-soft", `color-mix(in srgb, ${colors.accent} 16%, transparent)`);
  const tauriInternals = (window as Window & {
    __TAURI_INTERNALS__?: { metadata?: unknown };
  }).__TAURI_INTERNALS__;
  if (tauriInternals?.metadata) {
    void getCurrentWindow().setTheme(appearance).catch(() => undefined);
  }
  if (cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
    } catch {
      // The active theme remains valid for this session.
    }
  }
}

export function applyThemePreferences(preferences: UserPreferences): void {
  applyThemeSettings(themeSettingsFromPreferences(preferences));
}

export function announceThemePreferences(preferences: UserPreferences): void {
  applyThemePreferences(preferences);
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: preferences }));
}

export function initializeCachedTheme(): void {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as ThemeSettings | null;
    if (cached) applyThemeSettings(cached, false);
  } catch {
    // The default CSS theme is safe when cached preferences are invalid.
  }
}

export function installSystemThemeListener(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    if (currentSettings?.mode === "system" && currentSettings.preset === "default") {
      applyThemeSettings(currentSettings, false);
    }
  };
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
