import { useEffect, useState } from "react";

import {
  clearGallerySearchHistory,
  defaultSearchAndGroupingPreferences,
  loadGallerySearchHistory,
  loadSearchAndGroupingPreferences,
  saveSearchAndGroupingPreferences,
  type SearchAndGroupingPreferences,
} from "../services/gallerySearchHistory";
import { Icon } from "./Icon";

export function SearchAndGroupingSettings() {
  const [preferences, setPreferences] = useState<SearchAndGroupingPreferences>(
    defaultSearchAndGroupingPreferences,
  );
  const [historyCount, setHistoryCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void Promise.all([loadSearchAndGroupingPreferences(), loadGallerySearchHistory()]).then(
      ([loaded, history]) => {
        if (!active) return;
        setPreferences(loaded);
        setHistoryCount(history.length);
      },
    );
    return () => { active = false; };
  }, []);

  async function save(next: SearchAndGroupingPreferences) {
    const previous = preferences;
    setPreferences(next);
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    const saved = await saveSearchAndGroupingPreferences(next);
    setBusy(false);
    if (!saved) {
      setPreferences(previous);
      setError("検索とグループ表示の設定を保存できませんでした。");
      return;
    }
    const history = await loadGallerySearchHistory();
    setHistoryCount(history.length);
    setMessage("設定を保存しました。");
  }

  async function clearHistory() {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    await clearGallerySearchHistory();
    setHistoryCount(0);
    setBusy(false);
    setMessage("検索履歴を削除しました。");
  }

  return (
    <div className="search-grouping-settings">
      {(message || error) && (
        <div className={`inline-setting-message${error ? " error" : ""}`} role={error ? "alert" : "status"}>
          <Icon name={error ? "warning" : "check"} />{error ?? message}
        </div>
      )}
      <div className="setting-range-row search-history-setting">
        <span>
          <strong>検索履歴の保存件数</strong>
          <small>詳細検索で使った条件を最大10件まで再利用できます。現在 {historyCount}件です。</small>
        </span>
        <input
          type="range"
          min="1"
          max="10"
          step="1"
          value={preferences.searchHistoryLimit}
          disabled={busy}
          onChange={(event) => setPreferences((current) => ({
            ...current,
            searchHistoryLimit: Number(event.target.value),
          }))}
          onPointerUp={() => void save(preferences)}
          onKeyUp={() => void save(preferences)}
        />
        <output>{preferences.searchHistoryLimit}件</output>
        <button className="secondary-button" type="button" disabled={busy || historyCount === 0} onClick={() => void clearHistory()}>
          <Icon name="trash" />履歴を削除
        </button>
      </div>
    </div>
  );
}

export default SearchAndGroupingSettings;
