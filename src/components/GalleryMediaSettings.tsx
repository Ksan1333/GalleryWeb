import { useEffect, useState } from "react";
import { setJsonPreference } from "../services/native";
import {
  defaultGalleryMediaVisibility,
  galleryMediaVisibilityEvent,
  galleryMediaVisibilityKey,
  loadGalleryMediaVisibility,
  type GalleryMediaVisibility,
} from "../services/galleryMediaVisibility";
import "./BookViewerSettings.css";

export function GalleryMediaSettings() {
  const [settings, setSettings] = useState(defaultGalleryMediaVisibility);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadGalleryMediaVisibility().then((loaded) => {
      if (active) setSettings(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  async function update(next: GalleryMediaVisibility) {
    const previous = settings;
    setSettings(next);
    setSaving(true);
    setError(undefined);
    const result = await setJsonPreference(galleryMediaVisibilityKey, next);
    setSaving(false);
    if (!result.data || result.error) {
      setSettings(previous);
      setError(result.error ?? "ギャラリーの表示設定を保存できませんでした。");
      return;
    }
    window.dispatchEvent(new CustomEvent(galleryMediaVisibilityEvent, { detail: next }));
  }

  return (
    <div className="book-viewer-settings">
      <label className="book-setting-row">
        <span>
          <strong>動画をギャラリーに表示</strong>
          <small>オフにしても「動画」画面には引き続き表示されます。</small>
        </span>
        <input
          type="checkbox"
          checked={settings.video}
          disabled={saving}
          onChange={(event) => void update({ ...settings, video: event.target.checked })}
        />
        <i aria-hidden="true" />
      </label>
      <label className="book-setting-row">
        <span>
          <strong>ブックをギャラリーに表示</strong>
          <small>PDF・ZIP・CBZの表示だけをギャラリーから除外できます。</small>
        </span>
        <input
          type="checkbox"
          checked={settings.book}
          disabled={saving}
          onChange={(event) => void update({ ...settings, book: event.target.checked })}
        />
        <i aria-hidden="true" />
      </label>
      {error && <p className="book-setting-error">{error}</p>}
    </div>
  );
}
