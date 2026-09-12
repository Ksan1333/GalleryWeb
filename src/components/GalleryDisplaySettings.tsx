import { useEffect, useState } from "react";

import {
  defaultGalleryDisplayPreferences,
  galleryGroupOptions,
  galleryViewOptions,
  loadGalleryDisplayPreferences,
  mergeGalleryDisplayPreferences,
  saveGalleryDisplayPreferences,
  type GalleryDisplayPreferences,
  type GallerySortOrder,
} from "../services/galleryDisplayPreferences";
import "./GalleryDisplaySettings.css";

export * from "../services/galleryDisplayPreferences";

const ratingOptions: Array<{ value: GalleryDisplayPreferences["ageRating"]; label: string }> = [
  { value: "", label: "すべて" },
  { value: "UNRATED", label: "未選択" },
  { value: "SFW", label: "健全" },
  { value: "R15", label: "R-15" },
  { value: "R18", label: "R-18" },
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
        <span><strong>表示形式</strong><small>Windowsエクスプローラーと同じ種類から選べます。</small></span>
        <div className="gallery-display-segments">
          {galleryViewOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              className={preferences.viewMode === option.value ? "active" : ""}
              aria-pressed={preferences.viewMode === option.value}
              disabled={saving}
              onClick={() => void update({ viewMode: option.value })}
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
