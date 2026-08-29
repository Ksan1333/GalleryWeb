import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  listMediaItems,
  localAssetUrl,
  reportMediaLoadFailure,
  type LibraryRoot,
  type MediaItem,
} from "../services/native";
import type { FolderActivityRecord } from "../services/folderActivity";
import { useFolderActivity } from "../hooks/useFolderActivity";
import { markFirstMediaCard, markFirstMediaThumbnail } from "../services/performance";
import { useCoordinatedThumbnail } from "../services/thumbnailCoordinator";
import { Icon } from "./Icon";
import "./HomeShelves.css";

type HomeShelvesProps = {
  favoriteMedia: MediaItem[];
  mediaLoading: boolean;
  roots: LibraryRoot[];
  onOpenMedia: (mediaId: string) => void;
  onOpenFolder: (folder: FolderActivityRecord) => void;
  onRemoveFolderFavorite: (folder: FolderActivityRecord) => void;
};

function kindLabel(item: MediaItem): string {
  if (item.kind === "gif") return "GIF";
  if (item.kind === "video") return "動画";
  if (item.kind === "pdf" || item.kind === "archive") return "ブック";
  return "画像";
}

function HomeMediaVisual({ item }: { item: MediaItem }) {
  const thumbnail = useCoordinatedThumbnail(
    item.id,
    item.modifiedAt,
    item.thumbnailPath,
    "visible",
  );
  const source = localAssetUrl(item.thumbnailPath ?? thumbnail.path);
  const [failedSource, setFailedSource] = useState<string>();

  useEffect(markFirstMediaCard, []);

  useEffect(() => {
    setFailedSource(undefined);
  }, [item.id, item.modifiedAt, item.thumbnailPath]);

  if (source && source !== failedSource) {
    return (
      <img
        src={source}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={markFirstMediaThumbnail}
        onError={() => {
          setFailedSource(source);
          void reportMediaLoadFailure(item.id);
        }}
      />
    );
  }
  return (
    <span className={`home-media-placeholder kind-${item.kind}`} aria-hidden="true">
      <Icon name={item.kind === "video" ? "video" : item.kind === "pdf" || item.kind === "archive" ? "book" : "image"} />
    </span>
  );
}

function EmptyShelf({ icon, children }: { icon: "star" | "folder" | "clock"; children: string }) {
  return (
    <div className="home-shelf-empty">
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

const homeFolderPreviewRequests = new Map<string, Promise<MediaItem | undefined>>();

function loadHomeFolderPreview(folder: FolderActivityRecord): Promise<MediaItem | undefined> {
  const key = `${folder.rootId}\u0000${folder.relativePath}`;
  const cached = homeFolderPreviewRequests.get(key);
  if (cached) return cached;
  const request = listMediaItems({
    rootId: folder.rootId,
    folderPath: folder.relativePath,
    sortBy: "modifiedAt",
    sortDirection: "desc",
    limit: 1,
  }).then((result) => result.data[0]).catch(() => undefined);
  homeFolderPreviewRequests.set(key, request);
  // Share only requests that are currently in flight. Resolved previews must
  // flow through the catalog cache again so a rescan, move, or deletion can
  // replace a stale leading item.
  void request.finally(() => {
    if (homeFolderPreviewRequests.get(key) === request) {
      homeFolderPreviewRequests.delete(key);
    }
  });
  return request;
}

function FolderPreview({ folder }: { folder: FolderActivityRecord }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [preview, setPreview] = useState<MediaItem>();

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "180px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    setPreview(undefined);
    if (!visible) return;
    let active = true;
    void loadHomeFolderPreview(folder).then((item) => {
      if (active) setPreview(item);
    });
    return () => { active = false; };
  }, [folder.relativePath, folder.rootId, visible]);

  return (
    <span className="home-folder-preview-content" ref={hostRef}>
      {preview ? <HomeMediaVisual item={preview} /> : <Icon name="folder" />}
    </span>
  );
}

const FolderCard = memo(function FolderCard({
  folder,
  favorite,
  onOpen,
  onRemoveFavorite,
}: {
  folder: FolderActivityRecord;
  favorite: boolean;
  onOpen: () => void;
  onRemoveFavorite?: () => void;
}) {
  return (
    <article className="home-folder-card">
      <button type="button" className="home-folder-open" onClick={onOpen}>
        <span className="home-folder-preview"><FolderPreview folder={folder} /><i><Icon name="folder" /></i></span>
        <span className="home-shelf-copy">
          <strong title={folder.displayName}>{folder.displayName}</strong>
          <small title={`${folder.rootName} / ${folder.relativePath}`}>{folder.rootName}{folder.relativePath ? ` / ${folder.relativePath}` : ""}</small>
          <em>{folder.itemCount.toLocaleString("ja-JP")} 件{folder.visits > 0 ? ` · ${folder.visits.toLocaleString("ja-JP")} 回閲覧` : ""}</em>
        </span>
      </button>
      {favorite && onRemoveFavorite && (
        <button
          type="button"
          className="home-folder-favorite"
          aria-label={`${folder.displayName}をお気に入りフォルダーから外す`}
          title="お気に入りフォルダーから外す"
          onClick={onRemoveFavorite}
        >
          <Icon name="star" />
        </button>
      )}
    </article>
  );
});

export function HomeShelves({
  favoriteMedia,
  mediaLoading,
  roots,
  onOpenMedia,
  onOpenFolder,
  onRemoveFolderFavorite,
}: HomeShelvesProps) {
  const folderActivity = useFolderActivity();
  const validRootIds = useMemo(() => new Set(roots.map((root) => root.id)), [roots]);
  const favoriteFolders = useMemo(() => folderActivity
    .filter((folder) => folder.isFavorite && validRootIds.has(folder.rootId))
    .sort((left, right) => (right.lastVisitedAt ?? "").localeCompare(left.lastVisitedAt ?? ""))
    .slice(0, 24),
  [folderActivity, validRootIds]);
  const frequentFolders = useMemo(() => folderActivity
    .filter((folder) => folder.visits > 0 && validRootIds.has(folder.rootId))
    .sort((left, right) => right.visits - left.visits
      || (right.lastVisitedAt ?? "").localeCompare(left.lastVisitedAt ?? ""))
    .slice(0, 20), [folderActivity, validRootIds]);

  return (
    <div className="home-shelves">
      <section className="home-shelf-section">
        <header><span><Icon name="star" /></span><div><p className="kicker">FAVORITE MEDIA</p><h2>お気に入りメディア</h2></div></header>
        <div className="home-horizontal-shelf" aria-label="お気に入りメディア">
          {mediaLoading ? <EmptyShelf icon="star">お気に入りを読み込み中…</EmptyShelf> : favoriteMedia.length === 0
            ? <EmptyShelf icon="star">メディアの星を押すと、ここへすぐに表示されます。</EmptyShelf>
            : favoriteMedia.map((item) => (
              <button type="button" className="home-media-card" key={item.id} onClick={() => onOpenMedia(item.id)}>
                <span className="home-media-preview"><HomeMediaVisual item={item} /><i>{kindLabel(item)}</i></span>
                <span className="home-shelf-copy"><strong title={item.name}>{item.name}</strong><small title={item.path}>{item.path}</small></span>
              </button>
            ))}
        </div>
      </section>

      <section className="home-shelf-section">
        <header><span><Icon name="folder" /></span><div><p className="kicker">FAVORITE FOLDERS</p><h2>お気に入りフォルダ</h2></div></header>
        <div className="home-horizontal-shelf" aria-label="お気に入りフォルダ">
          {favoriteFolders.length === 0
            ? <EmptyShelf icon="folder">フォルダー画面の星を押すと、ここへ固定できます。</EmptyShelf>
            : favoriteFolders.map((folder) => (
              <FolderCard key={folder.key} folder={folder} favorite onOpen={() => onOpenFolder(folder)} onRemoveFavorite={() => onRemoveFolderFavorite(folder)} />
            ))}
        </div>
      </section>

      <section className="home-shelf-section">
        <header><span><Icon name="clock" /></span><div><p className="kicker">FREQUENT FOLDERS</p><h2>よく見るフォルダ</h2></div></header>
        <div className="home-horizontal-shelf" aria-label="よく見るフォルダ">
          {frequentFolders.length === 0
            ? <EmptyShelf icon="clock">フォルダーを開くと、閲覧回数の多い順に並びます。</EmptyShelf>
            : frequentFolders.map((folder) => (
              <FolderCard key={folder.key} folder={folder} favorite={false} onOpen={() => onOpenFolder(folder)} />
            ))}
        </div>
      </section>
    </div>
  );
}
