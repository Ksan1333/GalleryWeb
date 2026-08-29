import { useEffect, useState } from "react";
import { getJsonPreference, setJsonPreference } from "../services/native";
import { Icon } from "./Icon";
import "./BookViewerSettings.css";

export type VideoPlaybackPreferences = {
  loop: boolean;
  muted: boolean;
  volume: number;
};

export const VIDEO_PLAYBACK_PREFERENCE_KEY = "videoPlaybackPreferences";
export const VIDEO_PLAYBACK_SETTINGS_EVENT = "pixvault:video-playback-settings";
export const DEFAULT_VIDEO_PLAYBACK_PREFERENCES: VideoPlaybackPreferences = {
  loop: true,
  muted: false,
  volume: 0.5,
};

function normalizeVideoPlaybackPreferences(
  value: Partial<VideoPlaybackPreferences> | null | undefined,
): VideoPlaybackPreferences {
  return {
    loop: typeof value?.loop === "boolean"
      ? value.loop
      : DEFAULT_VIDEO_PLAYBACK_PREFERENCES.loop,
    muted: typeof value?.muted === "boolean"
      ? value.muted
      : DEFAULT_VIDEO_PLAYBACK_PREFERENCES.muted,
    volume: typeof value?.volume === "number" && Number.isFinite(value.volume)
      ? Math.max(0, Math.min(1, value.volume))
      : DEFAULT_VIDEO_PLAYBACK_PREFERENCES.volume,
  };
}

export async function loadVideoPlaybackPreferences(): Promise<VideoPlaybackPreferences> {
  const result = await getJsonPreference<Partial<VideoPlaybackPreferences>>(
    VIDEO_PLAYBACK_PREFERENCE_KEY,
    DEFAULT_VIDEO_PLAYBACK_PREFERENCES,
  );
  return normalizeVideoPlaybackPreferences(result.data);
}

export async function saveVideoPlaybackPreferences(
  value: VideoPlaybackPreferences,
): Promise<string | undefined> {
  const normalized = normalizeVideoPlaybackPreferences(value);
  const result = await setJsonPreference(VIDEO_PLAYBACK_PREFERENCE_KEY, normalized);
  if (result.data && !result.error) {
    window.dispatchEvent(new CustomEvent<VideoPlaybackPreferences>(
      VIDEO_PLAYBACK_SETTINGS_EVENT,
      { detail: normalized },
    ));
    return undefined;
  }
  return result.error ?? "動画の再生設定を保存できませんでした。";
}

export function VideoViewerSettings() {
  const [value, setValue] = useState<VideoPlaybackPreferences>(
    DEFAULT_VIDEO_PLAYBACK_PREFERENCES,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadVideoPlaybackPreferences().then((preferences) => {
      if (active) setValue(preferences);
    });
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<VideoPlaybackPreferences>).detail;
      if (detail) setValue(normalizeVideoPlaybackPreferences(detail));
    };
    window.addEventListener(VIDEO_PLAYBACK_SETTINGS_EVENT, handleChange);
    return () => {
      active = false;
      window.removeEventListener(VIDEO_PLAYBACK_SETTINGS_EVENT, handleChange);
    };
  }, []);

  const update = (patch: Partial<VideoPlaybackPreferences>) => {
    const previous = value;
    const next = normalizeVideoPlaybackPreferences({ ...value, ...patch });
    setValue(next);
    setSaving(true);
    setError(undefined);
    void saveVideoPlaybackPreferences(next).then((failure) => {
      setSaving(false);
      if (!failure) return;
      setValue(previous);
      setError(failure);
    });
  };

  return (
    <section className="book-viewer-settings video-viewer-settings" aria-label="動画ビュワー設定">
      <fieldset disabled={saving}>
        <legend>再生終了時</legend>
        <div>
          <button
            type="button"
            className={value.loop ? "is-active" : ""}
            aria-pressed={value.loop}
            onClick={() => update({ loop: true })}
          >
            <Icon name="refresh" />
            <span><b>ループ再生</b><small>終了後に先頭から再生（既定）</small></span>
          </button>
          <button
            type="button"
            className={!value.loop ? "is-active" : ""}
            aria-pressed={!value.loop}
            onClick={() => update({ loop: false })}
          >
            <Icon name="pause" />
            <span><b>1回だけ再生</b><small>終了した位置で停止</small></span>
          </button>
        </div>
      </fieldset>
      <fieldset disabled={saving}>
        <legend>再生開始時の音声</legend>
        <div>
          <button
            type="button"
            className={!value.muted ? "is-active" : ""}
            aria-pressed={!value.muted}
            onClick={() => update({
              muted: false,
              volume: value.volume > 0 ? value.volume : DEFAULT_VIDEO_PLAYBACK_PREFERENCES.volume,
            })}
          >
            <Icon name="volume" />
            <span><b>音声あり</b><small>前回の音量で自動再生（既定）</small></span>
          </button>
          <button
            type="button"
            className={value.muted ? "is-active" : ""}
            aria-pressed={value.muted}
            onClick={() => update({ muted: true })}
          >
            <Icon name="volumeOff" />
            <span><b>ミュート</b><small>消音状態で自動再生</small></span>
          </button>
        </div>
      </fieldset>
      {error && <p className="book-viewer-settings-error" role="alert">{error}</p>}
    </section>
  );
}
