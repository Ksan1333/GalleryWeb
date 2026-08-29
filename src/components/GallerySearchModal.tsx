import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  listLibraryRoots,
  listMediaFolders,
  listTags,
  type AgeRating,
  type LibraryRoot,
  type MediaFolder,
  type MediaKind,
  type Tag,
} from "../services/native";
import { useTagTranslations } from "../services/tagTranslations";
import { useAppBack } from "../hooks/useAppBack";
import type { GallerySearchHistoryEntry } from "../services/gallerySearchHistory";
import { Icon, type IconName } from "./Icon";
import "./GallerySearchModal.css";

export type GallerySearchMediaFormat = "image" | "gif" | "video" | "book";
export type GallerySearchPeriod = "all" | "today" | "7days" | "30days" | "year" | "custom";

export type GallerySearchFilters = {
  /**
   * An empty array means every supported media format. `book` expands to both
   * PDF and archive media when converted with `gallerySearchMediaKinds`.
   */
  mediaFormats: GallerySearchMediaFormat[];
  /** An undefined root searches every registered library root. */
  rootId?: string;
  /**
   * Physical folder relative to `rootId`. Undefined includes the whole root;
   * an empty string selects media stored directly below the root.
   */
  folderPath?: string;
  /** An undefined rating includes every age rating. */
  ageRating?: AgeRating;
  /** Selected tags are intended to be combined with AND semantics. */
  tagIds: string[];
  query: string;
  period: GallerySearchPeriod;
  customFrom?: string;
  customTo?: string;
};

export type GallerySearchModalProps = {
  open: boolean;
  value: GallerySearchFilters;
  allowedMediaFormats?: GallerySearchMediaFormat[];
  fixedRootId?: string;
  fixedFolderPath?: string;
  history?: GallerySearchHistoryEntry[];
  onSelectHistory?: (entry: GallerySearchHistoryEntry) => void;
  onDeleteHistory?: (id: string) => void;
  onApply: (filters: GallerySearchFilters) => void;
  onClear: () => void;
  onClose: () => void;
};

export const EMPTY_GALLERY_SEARCH_FILTERS: GallerySearchFilters = {
  mediaFormats: [],
  tagIds: [],
  query: "",
  period: "all",
};

const formatOptions: Array<{
  value: GallerySearchMediaFormat;
  label: string;
  detail: string;
  icon: IconName;
}> = [
  { value: "image", label: "画像", detail: "JPG・PNG・WebPなど", icon: "image" },
  { value: "gif", label: "GIF", detail: "アニメーション画像", icon: "play" },
  { value: "video", label: "動画", detail: "MP4・WebMなど", icon: "video" },
  { value: "book", label: "本", detail: "ZIP・CBZ・PDF", icon: "book" },
];

const ageRatingOptions: Array<{
  value: AgeRating;
  label: string;
  detail: string;
}> = [
  { value: "UNRATED", label: "未選択", detail: "区分未設定" },
  { value: "SFW", label: "健全", detail: "SFW" },
  { value: "R15", label: "R-15", detail: "15歳以上" },
  { value: "R18", label: "R-18", detail: "成人向け" },
];

const periodOptions: Array<{ value: GallerySearchPeriod; label: string; detail: string }> = [
  { value: "all", label: "すべて", detail: "期間を指定しない" },
  { value: "today", label: "今日", detail: "今日更新したメディア" },
  { value: "7days", label: "7日間", detail: "直近7日" },
  { value: "30days", label: "30日間", detail: "直近30日" },
  { value: "year", label: "今年", detail: "今年の1月1日から" },
  { value: "custom", label: "日付指定", detail: "開始日と終了日" },
];

function copyFilters(value: GallerySearchFilters): GallerySearchFilters {
  return {
    mediaFormats: [...value.mediaFormats],
    rootId: value.rootId,
    folderPath: value.folderPath,
    ageRating: value.ageRating,
    tagIds: [...value.tagIds],
    query: value.query,
    period: value.period ?? "all",
    customFrom: value.customFrom,
    customTo: value.customTo,
  };
}

function normalizedFilters(value: GallerySearchFilters): GallerySearchFilters {
  return {
    mediaFormats: [...new Set(value.mediaFormats)],
    rootId: value.rootId || undefined,
    folderPath: value.rootId ? value.folderPath : undefined,
    ageRating: value.ageRating,
    tagIds: [...new Set(value.tagIds)],
    query: value.query.trim(),
    period: value.period ?? "all",
    customFrom: value.period === "custom" ? value.customFrom : undefined,
    customTo: value.period === "custom" ? value.customTo : undefined,
  };
}

function dateInputMillis(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const result = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(result) ? result : undefined;
}

export function gallerySearchModifiedRange(
  filters: GallerySearchFilters,
): { modifiedFrom?: number; modifiedBefore?: number } {
  const now = new Date();
  switch (filters.period ?? "all") {
    case "today":
      return { modifiedFrom: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() };
    case "7days":
      return { modifiedFrom: now.getTime() - 7 * 24 * 60 * 60 * 1_000 };
    case "30days":
      return { modifiedFrom: now.getTime() - 30 * 24 * 60 * 60 * 1_000 };
    case "year":
      return { modifiedFrom: new Date(now.getFullYear(), 0, 1).getTime() };
    case "custom": {
      const modifiedFrom = dateInputMillis(filters.customFrom);
      const end = dateInputMillis(filters.customTo);
      if (modifiedFrom === undefined || end === undefined || modifiedFrom > end) return {};
      const modifiedBefore = new Date(end);
      modifiedBefore.setDate(modifiedBefore.getDate() + 1);
      return { modifiedFrom, modifiedBefore: modifiedBefore.getTime() };
    }
    default:
      return {};
  }
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

type FolderChoice = {
  relativeFolder: string;
  name: string;
  itemCount: number;
};

function directFolderChoices(folders: MediaFolder[], parentPath: string): FolderChoice[] {
  const prefix = parentPath ? `${parentPath}/` : "";
  const choices = new Map<string, FolderChoice>();
  for (const folder of folders) {
    if (!folder.relativeFolder.startsWith(prefix)) continue;
    const remaining = folder.relativeFolder.slice(prefix.length);
    if (!remaining) continue;
    const [name] = remaining.split("/");
    if (!name) continue;
    const relativeFolder = `${prefix}${name}`;
    const existing = choices.get(relativeFolder);
    if (existing) existing.itemCount += folder.itemCount;
    else choices.set(relativeFolder, { relativeFolder, name, itemCount: folder.itemCount });
  }
  return [...choices.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "ja", { numeric: true }),
  );
}

function RelativeFolderPath({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return <span className="gallery-search-relative-path">{path || "ルート直下"}</span>;
  return (
    <span className="gallery-search-relative-path middle-ellipsis" title={path}>
      <span>{segments[0]}</span>
      <i aria-hidden="true">…</i>
      <span>{segments.slice(-2).join("/")}</span>
    </span>
  );
}

export function gallerySearchMediaKinds(
  formats: GallerySearchMediaFormat[],
): MediaKind[] | undefined {
  if (formats.length === 0) return undefined;
  const kinds = formats.flatMap<MediaKind>((format) => {
    if (format === "book") return ["pdf", "archive"];
    return [format];
  });
  return [...new Set(kinds)];
}

export function hasGallerySearchFilters(filters: GallerySearchFilters): boolean {
  return Boolean(
    filters.query.trim()
      || filters.mediaFormats.length
      || filters.rootId
      || filters.folderPath !== undefined
      || filters.ageRating
      || filters.tagIds.length
      || (filters.period ?? "all") !== "all",
  );
}

export function GallerySearchModal({
  open,
  value,
  allowedMediaFormats,
  fixedRootId,
  fixedFolderPath,
  history = [],
  onSelectHistory,
  onDeleteHistory,
  onApply,
  onClear,
  onClose,
}: GallerySearchModalProps) {
  const [draft, setDraft] = useState<GallerySearchFilters>(() => copyFilters(value));
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [folderSearch, setFolderSearch] = useState("");
  const [folderCursor, setFolderCursor] = useState("");
  const [tagSearch, setTagSearch] = useState("");
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [optionError, setOptionError] = useState<string>();
  const [folderError, setFolderError] = useState<string>();
  const queryInputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const translateTag = useTagTranslations();
  useAppBack(open, onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    let active = true;
    setDraft(copyFilters({
      ...value,
      rootId: fixedRootId ?? value.rootId,
      folderPath: fixedRootId ? value.folderPath ?? fixedFolderPath : value.folderPath,
    }));
    setFolderSearch("");
    setFolderCursor(value.folderPath ?? "");
    setTagSearch("");
    setOptionError(undefined);
    setLoadingOptions(true);

    void Promise.all([listLibraryRoots(), listTags()]).then(([rootResult, tagResult]) => {
      if (!active) return;
      setRoots(rootResult.data);
      setTags(tagResult.data);
      setOptionError(rootResult.error || tagResult.error);
      setLoadingOptions(false);
    });

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => queryInputRef.current?.focus(), 40);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      active = false;
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !draft.rootId) {
      setFolders([]);
      setFolderError(undefined);
      setLoadingFolders(false);
      return;
    }

    let active = true;
    setFolderSearch("");
    setFolderCursor(draft.folderPath ?? "");
    setFolderError(undefined);
    setLoadingFolders(true);
    void listMediaFolders(draft.rootId).then((result) => {
      if (!active) return;
      setFolders(result.data);
      setFolderError(result.error);
      setLoadingFolders(false);
    });
    return () => {
      active = false;
    };
  }, [draft.rootId, open]);

  const visibleTags = useMemo(() => {
    const needle = tagSearch.trim().toLocaleLowerCase("ja");
    if (!needle) return tags;
    return tags.filter((tag) =>
      `${tag.name} ${translateTag(tag.name)}`.toLocaleLowerCase("ja").includes(needle),
    );
  }, [tagSearch, tags, translateTag]);

  const folderChoices = useMemo(
    () => directFolderChoices(folders, folderCursor),
    [folderCursor, folders],
  );
  const visibleFolders = useMemo(() => {
    const needle = folderSearch.trim().toLocaleLowerCase("ja");
    if (!needle) return folderChoices;
    return folderChoices.filter((folder) =>
      `${folder.name} ${folder.relativeFolder}`
        .toLocaleLowerCase("ja")
        .includes(needle),
    );
  }, [folderChoices, folderSearch]);
  const folderCursorSegments = folderCursor.split("/").filter(Boolean);
  const visibleFormatOptions = allowedMediaFormats
    ? formatOptions.filter((option) => allowedMediaFormats.includes(option.value))
    : formatOptions;

  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onApply(normalizedFilters({
      ...draft,
      rootId: fixedRootId ?? draft.rootId,
    }));
    onClose();
  }

  function clear() {
    setDraft(copyFilters({
      ...EMPTY_GALLERY_SEARCH_FILTERS,
      rootId: fixedRootId,
      folderPath: fixedRootId ? fixedFolderPath : undefined,
    }));
    setFolderSearch("");
    setTagSearch("");
    onClear();
  }

  const activeCount = [
    draft.mediaFormats.length > 0,
    !fixedRootId && Boolean(draft.rootId),
    fixedRootId
      ? draft.folderPath !== fixedFolderPath
      : draft.folderPath !== undefined,
    Boolean(draft.ageRating),
    draft.tagIds.length > 0,
    Boolean(draft.query.trim()),
    (draft.period ?? "all") !== "all",
  ].filter(Boolean).length;
  const customPeriodInvalid = draft.period === "custom" && (
    !draft.customFrom
    || !draft.customTo
    || (dateInputMillis(draft.customFrom) ?? Number.MAX_SAFE_INTEGER)
      > (dateInputMillis(draft.customTo) ?? Number.MIN_SAFE_INTEGER)
  );

  return (
    <div
      className="gallery-search-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="gallery-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gallery-search-title"
      >
        <header className="gallery-search-header">
          <div className="gallery-search-heading">
            <span className="gallery-search-heading-icon"><Icon name="search" /></span>
            <div>
              <p>ADVANCED SEARCH</p>
              <h2 id="gallery-search-title">ギャラリーを詳しく検索</h2>
            </div>
          </div>
          <button
            className="gallery-search-close"
            type="button"
            aria-label="検索画面を閉じる"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>

        <form onSubmit={submit}>
          <div className="gallery-search-body">
            <label className="gallery-search-query">
              <span>フリーワード</span>
              <div>
                <Icon name="search" />
                <input
                  ref={queryInputRef}
                  type="search"
                  value={draft.query}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, query: event.target.value }));
                  }}
                  placeholder="ファイル名・フォルダー名・タグから検索"
                />
                {draft.query && (
                  <button
                    type="button"
                    aria-label="入力を消去"
                    onClick={() => setDraft((current) => ({ ...current, query: "" }))}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </div>
            </label>

            {history.length > 0 && (
              <section className="gallery-search-history" aria-labelledby="gallery-search-history-title">
                <div>
                  <span><Icon name="clock" /><strong id="gallery-search-history-title">最近の検索条件</strong></span>
                  <small>{history.length}件</small>
                </div>
                <ul>
                  {history.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="gallery-search-history-restore"
                        onClick={() => {
                          onSelectHistory?.(entry);
                          onClose();
                        }}
                      >
                        <Icon name="clock" />
                        <span><strong>{entry.summary}</strong><small>{new Date(entry.createdAt).toLocaleString("ja-JP")}</small></span>
                        <Icon name="chevronRight" />
                      </button>
                      <button
                        type="button"
                        className="gallery-search-history-delete"
                        aria-label={`${entry.summary}を履歴から削除`}
                        onClick={() => onDeleteHistory?.(entry.id)}
                      >
                        <Icon name="trash" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <fieldset className="gallery-search-section">
              <legend><Icon name="gallery" />メディア形式</legend>
              <p>複数選択できます。何も選ばない場合はすべての形式が対象です。</p>
              <div className="gallery-search-format-grid">
                {visibleFormatOptions.map((option) => {
                  const selected = draft.mediaFormats.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      className={selected ? "gallery-search-format active" : "gallery-search-format"}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          mediaFormats: toggleValue(current.mediaFormats, option.value),
                        }));
                      }}
                    >
                      <span><Icon name={option.icon} /></span>
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                      <i aria-hidden="true"><Icon name="check" /></i>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <fieldset className="gallery-search-section gallery-search-period">
              <legend><Icon name="clock" />期間</legend>
              <p>ファイルの更新日時で絞り込みます。日付指定では開始日と終了日を含みます。</p>
              <div className="gallery-search-period-options">
                {periodOptions.map((option) => {
                  const selected = (draft.period ?? "all") === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={selected ? "active" : ""}
                      aria-pressed={selected}
                      onClick={() => setDraft((current) => ({
                        ...current,
                        period: option.value,
                      }))}
                    >
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                      {selected && <Icon name="check" />}
                    </button>
                  );
                })}
              </div>
              {draft.period === "custom" && (
                <div className={`gallery-search-date-range${customPeriodInvalid ? " is-invalid" : ""}`}>
                  <label>
                    <span>開始日</span>
                    <input
                      type="date"
                      value={draft.customFrom ?? ""}
                      max={draft.customTo || undefined}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        customFrom: event.target.value,
                      }))}
                    />
                  </label>
                  <Icon name="arrowRight" />
                  <label>
                    <span>終了日</span>
                    <input
                      type="date"
                      value={draft.customTo ?? ""}
                      min={draft.customFrom || undefined}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        customTo: event.target.value,
                      }))}
                    />
                  </label>
                  {customPeriodInvalid && <small>開始日と終了日を正しい順序で選択してください。</small>}
                </div>
              )}
            </fieldset>

            <div className="gallery-search-split">
              <fieldset className="gallery-search-section">
                <legend><Icon name="folder" />フォルダー</legend>
                <p>登録ルートを選び、その中の実フォルダーまで絞り込めます。</p>
                <div className="gallery-search-choice-list gallery-search-root-list">
                  {!fixedRootId && (
                    <button
                      className={!draft.rootId ? "active" : ""}
                      type="button"
                      aria-pressed={!draft.rootId}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          rootId: undefined,
                          folderPath: undefined,
                        }));
                      }}
                    >
                      <span><Icon name="hardDrive" />すべてのフォルダー</span>
                      {!draft.rootId && <Icon name="check" />}
                    </button>
                  )}
                  {roots.filter((root) => !fixedRootId || root.id === fixedRootId).map((root) => {
                    const selected = draft.rootId === root.id;
                    return (
                      <button
                        className={selected ? "active" : ""}
                        key={root.id}
                        type="button"
                        aria-pressed={selected}
                        title={root.path}
                        disabled={Boolean(fixedRootId)}
                        onClick={() => {
                          setFolderCursor("");
                          setFolderSearch("");
                          setDraft((current) => ({
                            ...current,
                            rootId: root.id,
                            folderPath: undefined,
                          }));
                        }}
                      >
                        <span><Icon name="folder" /><b>{root.displayName}</b></span>
                        {selected && <Icon name="check" />}
                      </button>
                    );
                  })}
                  {!loadingOptions && roots.length === 0 && (
                    <span className="gallery-search-empty-option">登録フォルダーはありません</span>
                  )}
                </div>
                {draft.rootId && (
                  <div className="gallery-search-subfolders">
                    <div className="gallery-search-subfolder-heading">
                      <span><Icon name="folder" />直下のフォルダー</span>
                      {folderChoices.length > 8 && (
                        <label>
                          <Icon name="search" />
                          <input
                            type="search"
                            value={folderSearch}
                            onChange={(event) => setFolderSearch(event.target.value)}
                            placeholder="フォルダーを絞り込み"
                          />
                        </label>
                      )}
                    </div>
                    <div className="gallery-search-folder-breadcrumbs" aria-label="検索フォルダー階層">
                      <button
                        type="button"
                        className={!folderCursor ? "active" : ""}
                        onClick={() => {
                          setFolderCursor("");
                          setFolderSearch("");
                          setDraft((current) => ({ ...current, folderPath: undefined }));
                        }}
                      >
                        ルート
                      </button>
                      {folderCursorSegments.map((segment, index) => {
                        const path = folderCursorSegments.slice(0, index + 1).join("/");
                        return (
                          <span key={path}>
                            <Icon name="chevronRight" />
                            <button
                              type="button"
                              className={folderCursor === path ? "active" : ""}
                              title={path}
                              onClick={() => {
                                setFolderCursor(path);
                                setFolderSearch("");
                                setDraft((current) => ({ ...current, folderPath: path }));
                              }}
                            >
                              {segment}
                            </button>
                          </span>
                        );
                      })}
                    </div>
                    <div className="gallery-search-choice-list gallery-search-subfolder-list">
                      <button
                        className={draft.folderPath === undefined ? "active" : ""}
                        type="button"
                        aria-pressed={draft.folderPath === undefined}
                        onClick={() => {
                          setDraft((current) => ({ ...current, folderPath: undefined }));
                          setFolderCursor("");
                          setFolderSearch("");
                        }}
                      >
                        <span><Icon name="hardDrive" /><b>登録フォルダー全体を検索</b></span>
                        {draft.folderPath === undefined && <Icon name="check" />}
                      </button>
                      {folders.some((folder) => folder.relativeFolder === "") && (
                        <button
                          className={draft.folderPath === "" ? "active" : ""}
                          type="button"
                          aria-pressed={draft.folderPath === ""}
                          onClick={() => {
                            setFolderCursor("");
                            setFolderSearch("");
                            setDraft((current) => ({ ...current, folderPath: "" }));
                          }}
                        >
                          <span>
                            <Icon name="folder" />
                            <span className="gallery-search-folder-copy">
                              <b>ルート直下のみ</b>
                              <small>登録フォルダー直下のファイル</small>
                            </span>
                          </span>
                          <span className="gallery-search-folder-count">
                            {(folders.find((folder) => folder.relativeFolder === "")?.itemCount ?? 0).toLocaleString("ja-JP")}
                          </span>
                          {draft.folderPath === "" && <Icon name="check" />}
                        </button>
                      )}
                      {visibleFolders.map((folder) => {
                        const selected = draft.folderPath === folder.relativeFolder;
                        return (
                          <button
                            className={selected ? "active" : ""}
                            key={folder.relativeFolder}
                            type="button"
                            aria-pressed={selected}
                            title={folder.relativeFolder}
                            onClick={() => {
                              setFolderCursor(folder.relativeFolder);
                              setFolderSearch("");
                              setDraft((current) => ({
                                ...current,
                                folderPath: folder.relativeFolder,
                              }));
                            }}
                          >
                            <span>
                              <Icon name="folder" />
                              <span className="gallery-search-folder-copy">
                                <b>{folder.name}</b>
                                <small><RelativeFolderPath path={folder.relativeFolder} /></small>
                              </span>
                            </span>
                            <span className="gallery-search-folder-count">
                              {folder.itemCount.toLocaleString("ja-JP")}
                            </span>
                            {selected && <Icon name="check" />}
                          </button>
                        );
                      })}
                      {loadingFolders && (
                        <span className="gallery-search-inline-loading">
                          <span className="spinner" aria-hidden="true" />フォルダーを集計中…
                        </span>
                      )}
                      {!loadingFolders && folders.length === 0 && (
                        <span className="gallery-search-empty-option">
                          この登録ルートにメディアフォルダーはありません
                        </span>
                      )}
                      {!loadingFolders && folders.length > 0 && visibleFolders.length === 0 && (
                        <span className="gallery-search-empty-option">
                          {folderSearch.trim()
                            ? `「${folderSearch.trim()}」に一致する直下フォルダーはありません`
                            : "この階層にサブフォルダーはありません"}
                        </span>
                      )}
                    </div>
                    {folderError && (
                      <span className="gallery-search-folder-error">
                        <Icon name="warning" />{folderError}
                      </span>
                    )}
                  </div>
                )}
              </fieldset>

              <fieldset className="gallery-search-section">
                <legend><Icon name="warning" />年齢区分</legend>
                <p>「すべて」は全区分、「未選択」はまだ健全度を設定していないメディアだけを含みます。</p>
                <div className="gallery-search-choice-list gallery-search-rating-list">
                  <button
                    className={!draft.ageRating ? "active" : ""}
                    type="button"
                    aria-pressed={!draft.ageRating}
                    onClick={() => setDraft((current) => ({ ...current, ageRating: undefined }))}
                  >
                    <span>すべて</span>
                    {!draft.ageRating && <Icon name="check" />}
                  </button>
                  {ageRatingOptions.map((option) => {
                    const selected = draft.ageRating === option.value;
                    return (
                      <button
                        className={selected ? `active rating-${option.value.toLowerCase()}` : ""}
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setDraft((current) => ({ ...current, ageRating: option.value }));
                        }}
                      >
                        <span><b>{option.label}</b><small>{option.detail}</small></span>
                        {selected && <Icon name="check" />}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            </div>

            <fieldset className="gallery-search-section gallery-search-tags">
              <legend><Icon name="tag" />タグ</legend>
              <div className="gallery-search-tags-heading">
                <p>選択したタグをすべて含むメディアを検索します。</p>
                {tags.length > 8 && (
                  <label>
                    <Icon name="search" />
                    <input
                      type="search"
                      value={tagSearch}
                      onChange={(event) => setTagSearch(event.target.value)}
                      placeholder="タグを絞り込み"
                    />
                  </label>
                )}
              </div>
              <div className="gallery-search-tag-list">
                {visibleTags.map((tag) => {
                  const selected = draft.tagIds.includes(tag.id);
                  const translated = translateTag(tag.name);
                  return (
                    <button
                      className={selected ? "active" : ""}
                      key={tag.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          tagIds: toggleValue(current.tagIds, tag.id),
                        }));
                      }}
                    >
                      {tag.color && (
                        <span
                          className="gallery-search-tag-color"
                          style={{ backgroundColor: tag.color }}
                        />
                      )}
                      <span title={translated !== tag.name ? tag.name : undefined}>{translated}</span>
                      {selected && <Icon name="check" />}
                    </button>
                  );
                })}
                {!loadingOptions && tags.length === 0 && (
                  <span className="gallery-search-empty-option">
                    タグはまだありません。メディア画面からタグを追加できます。
                  </span>
                )}
                {!loadingOptions && tags.length > 0 && visibleTags.length === 0 && (
                  <span className="gallery-search-empty-option">
                    「{tagSearch.trim()}」に一致するタグはありません
                  </span>
                )}
              </div>
            </fieldset>

            {loadingOptions && (
              <div className="gallery-search-loading" role="status">
                <span className="spinner" aria-hidden="true" />検索項目を読み込み中…
              </div>
            )}
            {optionError && (
              <div className="gallery-search-error" role="alert">
                <Icon name="warning" />{optionError}
              </div>
            )}
          </div>

          <footer className="gallery-search-footer">
            <div>
              <strong>{activeCount}</strong>
              <span>種類の条件を指定中</span>
            </div>
            <div>
              <button
                className="gallery-search-clear"
                type="button"
                disabled={!hasGallerySearchFilters(draft)}
                onClick={clear}
              >
                条件をクリア
              </button>
              <button className="gallery-search-cancel" type="button" onClick={onClose}>
                キャンセル
              </button>
              <button className="gallery-search-apply" type="submit" disabled={customPeriodInvalid}>
                <Icon name="search" />この条件で検索
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
