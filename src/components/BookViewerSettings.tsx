import { useEffect, useState } from "react";
import { getJsonPreference, setJsonPreference } from "../services/native";
import { Icon } from "./Icon";
import "./BookViewerSettings.css";

export type BookViewMode = "spread" | "single";
export type BookBinding = "left" | "right";

export type BookViewerSettingsValue = {
  viewMode: BookViewMode;
  binding: BookBinding;
  seekAnchorsEnabled: boolean;
  maxSeekAnchors: number;
};

export const BOOK_VIEW_MODE_KEY = "viewer.bookViewMode";
export const BOOK_BINDING_KEY = "viewer.bookBinding";
export const BOOK_SEEK_ANCHORS_ENABLED_KEY = "viewer.bookSeekAnchorsEnabled";
export const BOOK_MAX_SEEK_ANCHORS_KEY = "viewer.bookMaxSeekAnchors";
export const BOOK_VIEWER_SETTINGS_EVENT = "pixvault:book-viewer-settings";
export const DEFAULT_BOOK_VIEWER_SETTINGS: BookViewerSettingsValue = {
  viewMode: "spread",
  binding: "right",
  seekAnchorsEnabled: true,
  maxSeekAnchors: 3,
};

export async function loadBookViewerSettings(): Promise<BookViewerSettingsValue> {
  const [viewModeResult, bindingResult, anchorsResult, maxAnchorsResult] = await Promise.all([
    getJsonPreference<BookViewMode>(BOOK_VIEW_MODE_KEY, DEFAULT_BOOK_VIEWER_SETTINGS.viewMode),
    getJsonPreference<BookBinding>(BOOK_BINDING_KEY, DEFAULT_BOOK_VIEWER_SETTINGS.binding),
    getJsonPreference<boolean>(BOOK_SEEK_ANCHORS_ENABLED_KEY, DEFAULT_BOOK_VIEWER_SETTINGS.seekAnchorsEnabled),
    getJsonPreference<number>(BOOK_MAX_SEEK_ANCHORS_KEY, DEFAULT_BOOK_VIEWER_SETTINGS.maxSeekAnchors),
  ]);
  return {
    viewMode: viewModeResult.data === "single" ? "single" : "spread",
    binding: bindingResult.data === "right" ? "right" : "left",
    seekAnchorsEnabled: anchorsResult.data !== false,
    maxSeekAnchors: Math.max(1, Math.min(5, Math.round(Number(maxAnchorsResult.data) || 3))),
  };
}

export async function saveBookViewerSettings(
  patch: Partial<BookViewerSettingsValue>,
): Promise<string | undefined> {
  const results = await Promise.all([
    patch.viewMode === undefined
      ? Promise.resolve(undefined)
      : setJsonPreference(BOOK_VIEW_MODE_KEY, patch.viewMode),
    patch.binding === undefined
      ? Promise.resolve(undefined)
      : setJsonPreference(BOOK_BINDING_KEY, patch.binding),
    patch.seekAnchorsEnabled === undefined
      ? Promise.resolve(undefined)
      : setJsonPreference(BOOK_SEEK_ANCHORS_ENABLED_KEY, patch.seekAnchorsEnabled),
    patch.maxSeekAnchors === undefined
      ? Promise.resolve(undefined)
      : setJsonPreference(BOOK_MAX_SEEK_ANCHORS_KEY, Math.max(1, Math.min(5, Math.round(patch.maxSeekAnchors)))),
  ]);
  const error = results.find((result) => result?.error)?.error;
  if (!error) {
    window.dispatchEvent(new CustomEvent<Partial<BookViewerSettingsValue>>(
      BOOK_VIEWER_SETTINGS_EVENT,
      { detail: patch },
    ));
  }
  return error;
}

export function BookViewerSettings({ compact = false }: { compact?: boolean }) {
  const [value, setValue] = useState<BookViewerSettingsValue>(DEFAULT_BOOK_VIEWER_SETTINGS);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadBookViewerSettings().then((settings) => {
      if (active) setValue(settings);
    });
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<Partial<BookViewerSettingsValue>>).detail;
      setValue((current) => ({ ...current, ...detail }));
    };
    window.addEventListener(BOOK_VIEWER_SETTINGS_EVENT, handleChange);
    return () => {
      active = false;
      window.removeEventListener(BOOK_VIEWER_SETTINGS_EVENT, handleChange);
    };
  }, []);

  const update = (patch: Partial<BookViewerSettingsValue>) => {
    setValue((current) => ({ ...current, ...patch }));
    setError(undefined);
    void saveBookViewerSettings(patch).then((failure) => {
      if (failure) setError(failure);
    });
  };

  return (
    <section className={`book-viewer-settings${compact ? " is-compact" : ""}`} aria-label="ブックビュワー設定">
      {!compact && (
        <header>
          <span><Icon name="book" /></span>
          <div>
            <h3>ブックビュワー</h3>
            <p>見開き表示とページを読む方向を設定します。</p>
          </div>
        </header>
      )}
      <fieldset>
        <legend>既定のページ表示</legend>
        <div>
          <button type="button" className={value.viewMode === "spread" ? "is-active" : ""} aria-pressed={value.viewMode === "spread"} onClick={() => update({ viewMode: "spread" })}>
            <Icon name="book" /><span><b>見開き</b><small>2ページを並べる</small></span>
          </button>
          <button type="button" className={value.viewMode === "single" ? "is-active" : ""} aria-pressed={value.viewMode === "single"} onClick={() => update({ viewMode: "single" })}>
            <Icon name="file" /><span><b>単ページ</b><small>1ページずつ表示</small></span>
          </button>
        </div>
      </fieldset>
      <fieldset>
        <legend>綴じ方向</legend>
        <div>
          <button type="button" className={value.binding === "left" ? "is-active" : ""} aria-pressed={value.binding === "left"} onClick={() => update({ binding: "left" })}>
            <Icon name="arrowRight" /><span><b>左綴じ</b><small>左から右へ読む</small></span>
          </button>
          <button type="button" className={value.binding === "right" ? "is-active" : ""} aria-pressed={value.binding === "right"} onClick={() => update({ binding: "right" })}>
            <Icon name="arrowRight" className="book-viewer-settings-reverse" /><span><b>右綴じ</b><small>右から左へ読む（既定）</small></span>
          </button>
        </div>
      </fieldset>
      <fieldset className="book-seek-anchor-settings">
        <legend>シークアンカー（記憶点）</legend>
        <label className="book-viewer-setting-toggle">
          <span><b>シーク開始位置を記憶</b><small>離れたページへ移動したあと、開始位置へすぐ戻れます。</small></span>
          <input
            type="checkbox"
            checked={value.seekAnchorsEnabled}
            onChange={(event) => update({ seekAnchorsEnabled: event.target.checked })}
          />
        </label>
        {value.seekAnchorsEnabled && (
          <label className="book-viewer-setting-range">
            <span><b>アンカー記憶数</b><small>新しい順に1〜5件を保持します。</small></span>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={value.maxSeekAnchors}
              onChange={(event) => setValue((current) => ({ ...current, maxSeekAnchors: Number(event.target.value) }))}
              onPointerUp={() => update({ maxSeekAnchors: value.maxSeekAnchors })}
              onKeyUp={() => update({ maxSeekAnchors: value.maxSeekAnchors })}
            />
            <output>{value.maxSeekAnchors}件</output>
          </label>
        )}
      </fieldset>
      {error && <p className="book-viewer-settings-error" role="alert">{error}</p>}
    </section>
  );
}
