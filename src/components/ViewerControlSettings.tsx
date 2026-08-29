import { useEffect, useState } from "react";
import { getJsonPreference, setJsonPreference } from "../services/native";
import { Icon } from "./Icon";
import "./ViewerControlSettings.css";

export type ViewerActionId =
  | "favorite"
  | "tags"
  | "capture"
  | "reveal"
  | "recycle"
  | "rotate"
  | "ascii2d"
  | "wallpaper"
  | "slideshow"
  | "gifFrames"
  | "playPause"
  | "convertGif"
  | "bookmark"
  | "bookmarkList"
  | "bookSettings";

export type ViewerControlPreferences = {
  doubleClickZoom: boolean;
  videoSeekSeconds: 5 | 10 | 15 | 30;
  imageActions: ViewerActionId[];
  videoActions: ViewerActionId[];
  bookActions: ViewerActionId[];
};

export const VIEWER_CONTROL_PREFERENCE_KEY = "viewer.controlAssignments";
export const VIEWER_CONTROL_SETTINGS_EVENT = "pixvault:viewer-control-settings";

const imageActionIds: ViewerActionId[] = [
  "rotate", "favorite", "tags", "capture", "ascii2d", "wallpaper",
  "slideshow", "gifFrames", "reveal", "recycle",
];
const videoActionIds: ViewerActionId[] = [
  "playPause", "convertGif", "favorite", "tags", "capture", "reveal", "recycle",
];
const bookActionIds: ViewerActionId[] = [
  "bookmark", "bookmarkList", "bookSettings", "favorite", "tags", "capture",
  "reveal", "recycle",
];

export const VIEWER_ACTION_LABELS: Record<ViewerActionId, string> = {
  favorite: "お気に入り",
  tags: "タグ",
  capture: "スクリーンショット",
  reveal: "エクスプローラーで表示",
  recycle: "ごみ箱",
  rotate: "90°回転",
  ascii2d: "ascii2d",
  wallpaper: "壁紙",
  slideshow: "スライドショー",
  gifFrames: "GIFコマ展開",
  playPause: "再生・一時停止",
  convertGif: "GIF変換",
  bookmark: "しおり",
  bookmarkList: "しおり一覧",
  bookSettings: "ブック表示設定",
};

export const DEFAULT_VIEWER_CONTROL_PREFERENCES: ViewerControlPreferences = {
  doubleClickZoom: true,
  videoSeekSeconds: 10,
  imageActions: ["rotate", "favorite", "tags", "capture", "reveal"],
  videoActions: ["playPause", "convertGif", "favorite", "capture", "reveal"],
  bookActions: ["bookmark", "bookmarkList", "bookSettings", "capture", "reveal"],
};

function normalizeAssignments(
  value: unknown,
  allowed: ViewerActionId[],
  fallback: ViewerActionId[],
): ViewerActionId[] {
  const allowedSet = new Set(allowed);
  const raw = Array.isArray(value) ? value : [];
  const normalized = raw.filter(
    (entry): entry is ViewerActionId => typeof entry === "string" && allowedSet.has(entry as ViewerActionId),
  );
  const unique = [...new Set(normalized)];
  for (const fallbackAction of fallback) {
    if (unique.length >= 5) break;
    if (!unique.includes(fallbackAction)) unique.push(fallbackAction);
  }
  for (const action of allowed) {
    if (unique.length >= 5) break;
    if (!unique.includes(action)) unique.push(action);
  }
  return unique.slice(0, 5);
}

function normalizePreferences(value: Partial<ViewerControlPreferences> | null | undefined): ViewerControlPreferences {
  const seek = Number(value?.videoSeekSeconds);
  return {
    doubleClickZoom: value?.doubleClickZoom !== false,
    videoSeekSeconds: ([5, 10, 15, 30].includes(seek) ? seek : 10) as 5 | 10 | 15 | 30,
    imageActions: normalizeAssignments(value?.imageActions, imageActionIds, DEFAULT_VIEWER_CONTROL_PREFERENCES.imageActions),
    videoActions: normalizeAssignments(value?.videoActions, videoActionIds, DEFAULT_VIEWER_CONTROL_PREFERENCES.videoActions),
    bookActions: normalizeAssignments(value?.bookActions, bookActionIds, DEFAULT_VIEWER_CONTROL_PREFERENCES.bookActions),
  };
}

export async function loadViewerControlPreferences(): Promise<ViewerControlPreferences> {
  const result = await getJsonPreference<Partial<ViewerControlPreferences>>(
    VIEWER_CONTROL_PREFERENCE_KEY,
    DEFAULT_VIEWER_CONTROL_PREFERENCES,
  );
  return normalizePreferences(result.data);
}

export async function saveViewerControlPreferences(
  value: ViewerControlPreferences,
): Promise<string | undefined> {
  const normalized = normalizePreferences(value);
  const result = await setJsonPreference(VIEWER_CONTROL_PREFERENCE_KEY, normalized);
  if (!result.data || result.error) return result.error ?? "ビュワー操作設定を保存できませんでした。";
  window.dispatchEvent(new CustomEvent<ViewerControlPreferences>(
    VIEWER_CONTROL_SETTINGS_EVENT,
    { detail: normalized },
  ));
  return undefined;
}

type AssignmentKey = "imageActions" | "videoActions" | "bookActions";

export function ViewerControlSettings() {
  const [value, setValue] = useState(DEFAULT_VIEWER_CONTROL_PREFERENCES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void loadViewerControlPreferences().then((loaded) => {
      if (active) setValue(loaded);
    });
    return () => { active = false; };
  }, []);

  async function save(next: ViewerControlPreferences) {
    const previous = value;
    setValue(next);
    setSaving(true);
    setError(undefined);
    const failure = await saveViewerControlPreferences(next);
    setSaving(false);
    if (failure) {
      setValue(previous);
      setError(failure);
    }
  }

  function changeAssignment(
    key: AssignmentKey,
    index: number,
    action: ViewerActionId,
    allowed: ViewerActionId[],
  ) {
    const nextActions = [...value[key]];
    const duplicateIndex = nextActions.indexOf(action);
    if (duplicateIndex >= 0 && duplicateIndex !== index) {
      nextActions[duplicateIndex] = nextActions[index];
    }
    nextActions[index] = action;
    void save({
      ...value,
      [key]: normalizeAssignments(nextActions, allowed, nextActions),
    });
  }

  const assignmentEditor = (
    title: string,
    key: AssignmentKey,
    allowed: ViewerActionId[],
  ) => (
    <fieldset>
      <legend>{title}</legend>
      <div className="viewer-control-slots">
        {value[key].map((action, index) => (
          <label key={`${key}-${index}`}>
            <span>位置 {index + 1}</span>
            <select
              value={action}
              disabled={saving}
              onChange={(event) => changeAssignment(key, index, event.target.value as ViewerActionId, allowed)}
            >
              {allowed.map((option) => (
                <option key={option} value={option}>{VIEWER_ACTION_LABELS[option]}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <section className="viewer-control-settings" aria-label="ビュワー操作設定">
      <header>
        <span><Icon name="settings" /></span>
        <div>
          <h3>操作とボタンの割り当て</h3>
          <p>下部ツールバーの先頭5項目と、ズーム・動画送りを設定します。</p>
        </div>
      </header>
      <div className="viewer-control-behavior">
        <label>
          <span><b>ダブルクリックでズーム</b><small>画像をフィット表示と等倍表示で切り替えます。</small></span>
          <input
            type="checkbox"
            checked={value.doubleClickZoom}
            disabled={saving}
            onChange={(event) => void save({ ...value, doubleClickZoom: event.target.checked })}
          />
        </label>
        <label>
          <span><b>動画の送り秒数</b><small>左右キーで移動する秒数です。</small></span>
          <select
            value={value.videoSeekSeconds}
            disabled={saving}
            onChange={(event) => void save({ ...value, videoSeekSeconds: Number(event.target.value) as 5 | 10 | 15 | 30 })}
          >
            {[5, 10, 15, 30].map((seconds) => <option key={seconds} value={seconds}>{seconds}秒</option>)}
          </select>
        </label>
      </div>
      {assignmentEditor("画像・GIF", "imageActions", imageActionIds)}
      {assignmentEditor("動画", "videoActions", videoActionIds)}
      {assignmentEditor("ブック", "bookActions", bookActionIds)}
      {error && <p className="viewer-control-settings-error" role="alert">{error}</p>}
    </section>
  );
}
