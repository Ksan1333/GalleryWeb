import { useEffect, useRef, useState } from "react";
import { defaultPreferences, getPreferences, setPreference, showWindowsNotification, type UserPreferences } from "../services/native";
import { configureNativeNotifications } from "../services/notifications";
import { announceThemePreferences, THEME_CHANGED_EVENT, themePresets } from "../services/theme";
import { Icon } from "./Icon";
import "./GeneralSettings.css";

const customColors = [
  ["themeBackground", "背景"], ["themeSurface", "カード"], ["themeText", "本文"],
  ["themeMuted", "補助文字"], ["themeAccent", "アクセント"], ["themeDanger", "エラー"],
  ["themeSuccess", "成功"], ["themeBorder", "境界線"],
] as const;
type GeneralPreferenceKey = typeof customColors[number][0]
  | "theme" | "themePalette" | "watchFolders" | "autoAnalyze" | "nativeNotifications";

export function GeneralSettings({ nativeAvailable }: { nativeAvailable: boolean }) {
  const [preferences, setPreferences] = useState<UserPreferences>(defaultPreferences);
  const preferencesRef = useRef(preferences);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    let changedSinceLoad = false;
    const sync = (event: Event) => {
      const next = (event as CustomEvent<UserPreferences>).detail;
      if (!next) return;
      changedSinceLoad = true;
      preferencesRef.current = next;
      setPreferences(next);
      setLoaded(true);
    };
    window.addEventListener(THEME_CHANGED_EVENT, sync);
    void getPreferences().then((result) => {
      if (!active) return;
      if (!changedSinceLoad) {
        preferencesRef.current = result.data;
        setPreferences(result.data);
        setLoaded(!result.error);
        setError(result.error);
      }
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(String(cause));
      setLoading(false);
    });
    return () => { active = false; window.removeEventListener(THEME_CHANGED_EVENT, sync); };
  }, []);

  async function updatePreference(key: GeneralPreferenceKey, value: UserPreferences[GeneralPreferenceKey]) {
    if (!nativeAvailable || !loaded || loading || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await setPreference(key, value);
      if (!result.available || result.error || !result.data) {
        throw new Error(result.error ?? "設定を保存できませんでした。");
      }
      const next = { ...preferencesRef.current, [key]: value };
      preferencesRef.current = next;
      setPreferences(next);
      announceThemePreferences(next);
      configureNativeNotifications(next.nativeNotifications);
      setMessage("設定を保存しました。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function testNotification() {
    if (!nativeAvailable || !loaded || !preferencesRef.current.nativeNotifications || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await showWindowsNotification("PixVaultの通知テスト", "Windows通知の送信テストです。", "success");
      if (!result.available || result.error || !result.data) throw new Error(result.error ?? "Windows通知を送信できませんでした。");
      setMessage("Windowsへテスト通知を送信しました。表示はWindowsの通知・集中モード設定に従います。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { busyRef.current = false; setBusy(false); }
  }

  const disabled = !nativeAvailable || !loaded || loading || busy;
  return <section className="settings-panel general-settings" aria-labelledby="general-settings-title" aria-busy={loading || busy}>
    <div className="section-heading"><div><h2 id="general-settings-title">表示テーマと自動処理</h2></div></div>
    {loading && <p role="status">設定を読み込んでいます…</p>}
    {(error || message) && <p className={`operation-message${error ? " error" : " success"}`} role={error ? "alert" : "status"}>{error ?? message}</p>}
    {!nativeAvailable && <p className="muted-copy">設定の保存と通知はWindowsアプリで利用できます。</p>}
    <div className="preference-list">
      <label><span><strong>表示テーマ</strong><small>標準配色の明暗を選びます。システム設定はWindowsに追従します。</small></span>
        <select value={preferences.theme} disabled={disabled} onChange={(event) => void updatePreference("theme", event.target.value)}>
          <option value="system">システム設定</option><option value="dark">ダーク</option><option value="light">ライト</option>
        </select>
      </label>
      <label><span><strong>カラープリセット</strong><small>プリセットは固有の明暗・配色を使用します。</small></span>
        <select value={preferences.themePalette} disabled={disabled} onChange={(event) => void updatePreference("themePalette", event.target.value)}>
          <option value="default">標準</option>
          {themePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          <option value="custom">カスタム</option>
        </select>
      </label>
      {preferences.themePalette === "custom" && <div className="theme-color-editor" role="group" aria-label="カスタム配色">
        {customColors.map(([key, label]) => <label key={key}><span>{label}</span>
          <input type="color" aria-label={`${label}の色`} value={/^#[0-9a-f]{6}$/i.test(preferences[key]) ? preferences[key] : defaultPreferences[key]}
            disabled={disabled} onChange={(event) => void updatePreference(key, event.target.value)} />
          <code>{preferences[key]}</code>
        </label>)}
      </div>}
      {([
        ["watchFolders", "ファイル変更を自動反映", "優先フォルダーの配下と閲覧済みフォルダーの変更を監視します。"],
        ["autoAnalyze", "新しい画像を自動解析", "監視で追加された画像・GIFをAI解析の待ち行列に追加します。"],
        ["nativeNotifications", "Windows通知", "解析完了や新しいメディアの追加をWindowsへ通知します。"],
      ] as const).map(([key, label, detail]) => <label className="switch-row" key={key}>
        <span><strong>{label}</strong><small>{detail}</small></span>
        <input type="checkbox" role="switch" checked={preferences[key]} disabled={disabled}
          onChange={(event) => void updatePreference(key, event.target.checked)} />
        <span className="switch-control" aria-hidden="true"><span /></span>
      </label>)}
      <div className="preference-inline-action"><span><strong>通知の動作確認</strong><small>Windowsの通知設定が優先されます。</small></span>
        <button type="button" className="secondary-button" disabled={disabled || !preferences.nativeNotifications} onClick={() => void testNotification()}><Icon name="bell" />テスト通知</button>
      </div>
    </div>
  </section>;
}
