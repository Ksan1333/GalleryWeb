import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import {
  getAdjacentSimilarityGroups,
  getMediaItemsByIds,
  mediaAssetUrl,
  type AdjacentSimilarityResult,
  type MediaItem,
  type MediaQuery,
} from "../services/native";
import { Icon } from "./Icon";

const MediaViewer = lazy(() => import("./MediaViewer").then((module) => ({ default: module.MediaViewer })));

const emptyResult: AdjacentSimilarityResult = {
  groups: [],
  indexedCount: 0,
  candidateCount: 0,
  pending: false,
};

export function AdjacentSimilarityGroups({
  query,
  threshold,
  refreshVersion,
}: {
  query: MediaQuery;
  threshold: number;
  refreshVersion?: number;
}) {
  const [result, setResult] = useState(emptyResult);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const [selectedItems, setSelectedItems] = useState<MediaItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [retryVersion, setRetryVersion] = useState(0);
  const queryKey = useMemo(() => JSON.stringify({ ...query, limit: undefined, offset: undefined }), [query]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void getAdjacentSimilarityGroups(query, threshold / 100).then((response) => {
      if (!active) return;
      setResult(response.data);
      setError(response.error);
      setLoading(false);
    });
    return () => { active = false; };
  }, [queryKey, refreshVersion, retryVersion, threshold]);

  useEffect(() => {
    if (!result.pending || loading) return;
    const timer = window.setTimeout(() => setRetryVersion((current) => current + 1), 6_000);
    return () => window.clearTimeout(timer);
  }, [loading, result.indexedCount, result.pending]);

  async function openGroup(mediaIds: string[]) {
    setError(undefined);
    const response = await getMediaItemsByIds(mediaIds);
    if (response.error || response.data.length === 0) {
      setError(response.error ?? "類似画像グループを開けませんでした。");
      return;
    }
    setSelectedItems(response.data);
    setSelectedId(response.data[0].id);
  }

  if (!loading && result.candidateCount < 2 && !error) return null;
  const visibleGroups = showAll ? result.groups : result.groups.slice(0, 12);

  return (
    <section className="adjacent-similarity-panel" aria-labelledby="adjacent-similarity-title">
      <header>
        <span>
          <Icon name="gallery" />
          <span>
            <strong id="adjacent-similarity-title">隣接する類似画像</strong>
            <small>
              {loading
                ? "日時順の画像を確認しています…"
                : `${result.groups.length}グループ · ベクトル ${result.indexedCount.toLocaleString("ja-JP")}/${result.candidateCount.toLocaleString("ja-JP")}件`}
            </small>
          </span>
        </span>
        <span className="state-chip">{threshold}%以上</span>
      </header>
      {error && <div className="inline-setting-message error" role="alert"><Icon name="warning" />{error}</div>}
      {loading ? (
        <div className="adjacent-similarity-loading"><span className="spinner" />類似画像をまとめています…</div>
      ) : result.groups.length === 0 ? (
        <div className="adjacent-similarity-empty">
          <Icon name={result.pending ? "refresh" : "check"} className={result.pending ? "rotating" : undefined} />
          <span>
            <strong>{result.pending ? "AIベクトルを準備中です" : "一致するグループはありません"}</strong>
            <small>{result.pending ? "準備が進むと自動的に再確認します。" : "一致率を下げると候補が増える場合があります。"}</small>
          </span>
        </div>
      ) : (
        <>
          <div className="adjacent-similarity-grid">
            {visibleGroups.map((group) => {
              const source = mediaAssetUrl(group.representative);
              return (
                <button type="button" key={group.id} onClick={() => void openGroup(group.mediaIds)}>
                  <span className="adjacent-similarity-cover">
                    {source ? <img src={source} alt="" /> : <Icon name="image" />}
                    <b><Icon name="gallery" />{group.mediaIds.length}</b>
                  </span>
                  <span>
                    <strong>{group.representative.name}</strong>
                    <small>最低一致率 {Math.round(group.minimumSimilarity * 100)}%</small>
                  </span>
                </button>
              );
            })}
          </div>
          {result.groups.length > 12 && (
            <button className="text-button adjacent-similarity-more" type="button" onClick={() => setShowAll((current) => !current)}>
              {showAll ? "12グループまで表示" : `残り${result.groups.length - 12}グループを表示`}
            </button>
          )}
        </>
      )}
      {selectedId && selectedItems.length > 0 && (
        <Suspense fallback={null}>
          <MediaViewer
            items={selectedItems}
            currentId={selectedId}
            onClose={() => {
              setSelectedId(undefined);
              setSelectedItems([]);
            }}
            onItemPatch={(mediaId, patch) => setSelectedItems((current) => current.map((item) =>
              item.id === mediaId ? { ...item, ...patch } : item))}
            onRemove={(mediaId) => {
              const next = selectedItems.filter((item) => item.id !== mediaId);
              setSelectedItems(next);
              setSelectedId(next[0]?.id);
            }}
            onCurrentIdChange={setSelectedId}
          />
        </Suspense>
      )}
    </section>
  );
}

export default AdjacentSimilarityGroups;
