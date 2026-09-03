import { useEffect, useState } from "react";

import {
  getJsonPreference,
  setJsonPreference,
  type AgeRating,
} from "../services/native";
import "./GalleryDisplaySettings.css";

export type GalleryGridSize = "minimum" | "small" | "medium" | "large" | "maximum";
export type GalleryGroupMode = "day" | "month" | "year" | "none";
export type GallerySortOrder =
  | "modified-desc"
  | "modified-asc"
  | "name-asc"
  | "name-desc"
  | "size-desc"
  | "size-asc";

export type GalleryDisplayPreferences = {
  gridSize: GalleryGridSize;
  groupMode: GalleryGroupMode;
  ageRating: AgeRating | "";
  sortOrder: GallerySortOrder;
};

export const galleryDisplayPreferencesKey = "galleryDisplayPreferences";
export const galleryDisplayPreferencesEvent = "pixvault:gallery-display-preferences";
export const defaultGalleryDisplayPreferences: GalleryDisplayPreferences = {
  gridSize: "medium",
  groupMode: "none",
  ageRating: "",
  sortOrder: "modified-desc",
};

export function normalizeGalleryDisplayPreferences(
  value: Partial<GalleryDisplayPreferences> | null | undefined,
): GalleryDisplayPreferences {
  const gridSize = value?.gridSize;
  const groupMode = value?.groupMode;
  const sortOrder = value?.sortOrder;
  const normalizedSortOrder: GallerySortOrder = sortOrder === "modified-asc"
    || sortOrder === "name-asc"
    || sortOrder === "name-desc"
    || sortOrder === "size-desc"
    || sortOrder === "size-asc"
    ? sortOrder
    : "modified-desc";
  const normalizedGroupMode: GalleryGroupMode = groupMode === "day"
    || groupMode === "month"
    || groupMode === "year"
    ? groupMode
    : "none";
  return {
    gridSize: gridSize === "minimum"
      || gridSize === "small"
      || gridSize === "large"
      || gridSize === "maximum"
      ? gridSize
      : "medium",
    groupMode: normalizedSortOrder.startsWith("modified-") ? normalizedGroupMode : "none",
    ageRating: value?.ageRating === "UNRATED"
      || value?.ageRating === "SFW"
      || value?.ageRating === "R15"
      || value?.ageRating === "R18"
      ? value.ageRating
      : "",
    sortOrder: normalizedSortOrder,
  };
}

export function mergeGalleryDisplayPreferences(
  current: GalleryDisplayPreferences,
  patch: Partial<GalleryDisplayPreferences>,
): GalleryDisplayPreferences {
  const adjusted = { ...current, ...patch };
  if (
    patch.groupMode
    && patch.groupMode !== "none"
    && !adjusted.sortOrder.startsWith("modified-")
  ) {
    adjusted.sortOrder = "modified-desc";
  }
  if (patch.sortOrder && !patch.sortOrder.startsWith("modified-")) {
    adjusted.groupMode = "none";
  }
  return normalizeGalleryDisplayPreferences(adjusted);
}

export async function loadGalleryDisplayPreferences(): Promise<GalleryDisplayPreferences> {
  const result = await getJsonPreference<Partial<GalleryDisplayPreferences>>(
    galleryDisplayPreferencesKey,
    defaultGalleryDisplayPreferences,
  );
  return normalizeGalleryDisplayPreferences(result.data);
}

export async function saveGalleryDisplayPreferences(
  preferences: GalleryDisplayPreferences,
): Promise<{ saved: boolean; error?: string }> {
  const normalized = normalizeGalleryDisplayPreferences(preferences);
  const result = await setJsonPreference(galleryDisplayPreferencesKey, normalized);
  if (!result.data || result.error) {
    return {
      saved: false,
      error: result.error ?? "ギャラリー表示設定を保存できませんでした。",
    };
  }
  window.dispatchEvent(new CustomEvent(galleryDisplayPreferencesEvent, {
    detail: normalized,
  }));
  return { saved: true };
}

const sizeOptions: Array<{ value: GalleryGridSize; label: string; detail: string }> = [
  { value: "minimum", label: "最小", detail: "10列・ファイル名を非表示" },
  { value: "small", label: "小", detail: "7列" },
  { value: "medium", label: "中", detail: "5列・標準" },
  { value: "large", label: "大", detail: "3列" },
  { value: "maximum", label: "最大", detail: "2列・画像全体を表示" },
];

const ratingOptions: Array<{ value: GalleryDisplayPreferences["ageRating"]; label: string }> = [
  { value: "", label: "すべて" },
  { value: "UNRATED", label: "未選択" },
  { value: "SFW", label: "健全" },
  { value: "R15", label: "R-15" },
  { value: "R18", label: "R-18" },
];

export const galleryGroupOptions: Array<{ value: GalleryGroupMode; label: string }> = [
  { value: "none", label: "なし" },
  { value: "day", label: "更新日ごと" },
  { value: "month", label: "更新月ごと" },
  { value: "year", label: "更新年ごと" },
];

const sortOptions: Array<{ value: GallerySortOrder; label: string }> = [
  { value: "modified-desc", label: "更新 新→旧" },
  { value: "modified-asc", label: "更新 旧→新" },
  { value: "name-asc", label: "名前 A→Z" },
  { value: "name-desc", label: "名前 Z→A" },
  { value: "size-desc", label: "サイズ 大→小" },
  { value: "size-asc", label: "サイズ 小→大" },
];

export function GalleryDisplaySettings() {
  const [preferences, setPreferences] = useState(defaultGalleryDisplayPreferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadGalleryDisplayPreferences().then((loaded) => {
      if (active) setPreferences(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  async function update(patch: Partial<GalleryDisplayPreferences>) {
    const previous = preferences;
    const next = mergeGalleryDisplayPreferences(previous, patch);
    setPreferences(next);
    setSaving(true);
    setError(undefined);
    const result = await saveGalleryDisplayPreferences(next);
    setSaving(false);
    if (!result.saved) {
      setPreferences(previous);
      setError(result.error);
    }
  }

  return (
    <div className="gallery-display-settings">
      <div className="gallery-display-setting-row">
        <span><strong>サムネイルサイズ</strong><small>すべてのギャラリーへ反映します。</small></span>
        <div className="gallery-display-segments">
          {sizeOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              className={preferences.gridSize === option.value ? "active" : ""}
              aria-pressed={preferences.gridSize === option.value}
              disabled={saving}
              title={option.detail}
              onClick={() => void update({ gridSize: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="gallery-display-setting-row">
        <span><strong>グループ化</strong><small>Windowsエクスプローラーのように更新日単位の見出しで区切ります。</small></span>
        <div className="gallery-display-segments">
          {galleryGroupOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              className={preferences.groupMode === option.value ? "active" : ""}
              aria-pressed={preferences.groupMode === option.value}
              disabled={saving}
              onClick={() => void update({ groupMode: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="gallery-display-setting-row">
        <span><strong>並び順</strong><small>ギャラリーの右クリックからも変更できます。</small></span>
        <div className="gallery-display-segments gallery-display-sort-segments">
          {sortOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              className={preferences.sortOrder === option.value ? "active" : ""}
              aria-pressed={preferences.sortOrder === option.value}
              disabled={saving}
              onClick={() => void update({ sortOrder: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="gallery-display-setting-row">
        <span><strong>表示する年齢制限</strong><small>右クリックメニューからも変更できます。</small></span>
        <div className="gallery-display-segments">
          {ratingOptions.map((option) => (
            <button
              type="button"
              key={option.value || "all"}
              className={preferences.ageRating === option.value ? "active" : ""}
              aria-pressed={preferences.ageRating === option.value}
              disabled={saving}
              onClick={() => void update({ ageRating: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="gallery-display-setting-error">{error}</p>}
    </div>
  );
}
