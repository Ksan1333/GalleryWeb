import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  cacheTemporaryDrawingReference,
  cleanupTemporaryDrawingReferences,
  deleteXHistory,
  downloadXPost,
  failXGifFinalization,
  finalizeXGif,
  getDefaultXDownloadDirectory,
  getJsonPreference,
  inspectXPost,
  listMediaItems,
  listXHistory,
  localAssetUrl,
  pickDrawingReference,
  setJsonPreference,
  type MediaItem,
  type XHistoryItem,
  type XDownloadedMedia,
  type XMediaSelection,
  type XPostInspection,
} from "../services/native";
import { startOperation, type OperationHandle } from "../services/operations";
import { useAppBack } from "../hooks/useAppBack";
import { Icon } from "./Icon";
import { EmptyState, LoadingPanel, PageHeader, SelectMenu } from "./Ui";
import {
  WebSearchModal,
  type WebSearchResult,
} from "./WebSearchModal";
import {
  X_DOWNLOAD_DIRECTORY_CHANGED_EVENT,
  X_DOWNLOAD_DIRECTORY_KEY,
  XDownloadDirectorySetting,
} from "./XDownloadDirectorySetting";
import "./ExtraPages.css";

type FavoriteSite = {
  id: string;
  name: string;
  url: string;
  description?: string;
};

type CreatorLink = {
  id: string;
  platform: string;
  url: string;
};

type FavoriteCreator = {
  id: string;
  name: string;
  links: CreatorLink[];
};

type CreatorLinkDraft = {
  id: string;
  platform: string;
  url: string;
};

type ReferenceSource = "local" | "gallery" | "url" | "web";

type DrawingReference = {
  id: string;
  name: string;
  path: string;
  source?: ReferenceSource;
  mediaId?: string;
  previewUrl?: string;
  temporary?: boolean;
  originalPath?: string;
};

type ReferenceProject = {
  id: string;
  name: string;
  status: "active" | "finished";
  createdAt: string;
  items: DrawingReference[];
};

type ReferenceAddMode = "choose" | "url" | "gallery";

const SITE_KEY = "favorites.sites";
const CREATOR_KEY = "favorites.creators";
const REFERENCE_KEY = "drawing.references";
const platforms = [
  "X",
  "pixiv",
  "FANBOX",
  "Fantia",
  "Patreon",
  "Instagram",
  "YouTube",
  "Bluesky",
  "支援サイト",
  "ポートフォリオ",
  "公式サイト",
  "その他",
];
const platformOptions = platforms.map((platform) => ({
  value: platform,
  label: platform,
}));

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function normalizeHttpUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith("\\\\")) {
    return undefined;
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/.test(parsed.protocol)) return undefined;
    if (parsed.username || parsed.password || !parsed.hostname) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return (
      /^https?:$/.test(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function referenceNameFromUrl(value: string, preferredName = ""): string {
  if (preferredName.trim()) return preferredName.trim();
  try {
    const parsed = new URL(value);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      try {
        return decodeURIComponent(lastSegment);
      } catch {
        return lastSegment;
      }
    }
    return parsed.hostname;
  } catch {
    return value;
  }
}

function normalizeSites(value: unknown): FavoriteSite[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = asRecord(entry);
    const url = normalizeHttpUrl(stringValue(item.url));
    if (!url) return [];
    return [{
      id: stringValue(item.id, makeId()),
      name: stringValue(item.name, url),
      url,
      description: stringValue(item.description) || undefined,
    }];
  });
}

function normalizeCreators(value: unknown): FavoriteCreator[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = asRecord(entry);
    const name = stringValue(item.name).trim();
    const rawLinks = Array.isArray(item.links)
      ? item.links
      : item.url
        ? [{ id: item.id, platform: "リンク", url: item.url }]
        : [];
    const links = rawLinks.flatMap((rawLink) => {
      const link = asRecord(rawLink);
      const url = normalizeHttpUrl(stringValue(link.url));
      if (!url) return [];
      return [{
        id: stringValue(link.id, makeId()),
        platform: stringValue(link.platform, "リンク"),
        url,
      }];
    });
    return name && links.length > 0
      ? [{ id: stringValue(item.id, makeId()), name, links }]
      : [];
  });
}

function normalizeReference(rawReference: unknown): DrawingReference | undefined {
  const reference = asRecord(rawReference);
  const rawPath = stringValue(reference.path, stringValue(reference.url));
  if (!rawPath) return undefined;
  const remotePath = isHttpUrl(rawPath)
    ? normalizeHttpUrl(rawPath)
    : undefined;
  const path = remotePath ?? rawPath;
  const rawSource = stringValue(reference.source);
  const source: ReferenceSource =
    rawSource === "gallery" ||
    rawSource === "url" ||
    rawSource === "web" ||
    rawSource === "local"
      ? rawSource
      : remotePath
        ? "url"
        : "local";
  const previewUrl = normalizeHttpUrl(stringValue(reference.previewUrl));
  return {
    id: stringValue(reference.id, makeId()),
    name: stringValue(
      reference.name,
      remotePath ? referenceNameFromUrl(remotePath) : fileName(path),
    ),
    path,
    source,
    mediaId: stringValue(reference.mediaId) || undefined,
    previewUrl,
    temporary: reference.temporary === true,
    originalPath: stringValue(reference.originalPath) || undefined,
  };
}

function normalizeProjects(value: unknown): ReferenceProject[] {
  if (!Array.isArray(value)) return [];
  const normalizedProjects: ReferenceProject[] = [];
  for (const entry of value) {
    const item = asRecord(entry);
    if (!Array.isArray(item.items)) continue;
    const name = stringValue(item.name).trim();
    if (!name) continue;
    normalizedProjects.push({
      id: stringValue(item.id, makeId()),
      name,
      status: item.status === "finished" ? "finished" : "active",
      createdAt: stringValue(item.createdAt, new Date().toISOString()),
      items: item.items
        .map(normalizeReference)
        .filter((reference): reference is DrawingReference => Boolean(reference)),
    });
  }
  if (normalizedProjects.length > 0) return normalizedProjects;

  const legacyItems = value
    .map(normalizeReference)
    .filter((reference): reference is DrawingReference => Boolean(reference));
  return legacyItems.length > 0
    ? [{
        id: makeId(),
        name: "既存の資料",
        status: "active",
        createdAt: new Date().toISOString(),
        items: legacyItems,
      }]
    : [];
}

function newCreatorLinkDraft(): CreatorLinkDraft {
  return { id: makeId(), platform: platforms[0], url: "" };
}

function OperationMessage({ error }: { error?: string }) {
  return error ? (
    <div className="operation-message error" role="alert">
      <Icon name="warning" />
      {error}
    </div>
  ) : null;
}

function ExtraModal({
  open,
  title,
  description,
  wide = false,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useAppBack(open, onClose);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableElements = () =>
      [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.getClientRects().length > 0);
    const focusTimer = window.setTimeout(() => focusableElements()[0]?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="extra-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`extra-modal-dialog ${wide ? "is-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p className="kicker">DRAWING REFERENCE</p>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="閉じる"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="extra-modal-content">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}

const ReferenceThumbnail = memo(function ReferenceThumbnail({
  reference,
}: {
  reference: DrawingReference;
}) {
  const source = reference.previewUrl
    ?? (isHttpUrl(reference.path)
      ? reference.path
      : localAssetUrl(reference.path));
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [source]);

  if (!source || failed) {
    return (
      <div className="reference-preview-fallback">
        <Icon name={isHttpUrl(reference.path) ? "external" : "file"} />
        <span>{isHttpUrl(reference.path) ? "Web資料" : "プレビューなし"}</span>
      </div>
    );
  }
  return (
    <img
      src={source}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
});

const GalleryItemThumbnail = memo(function GalleryItemThumbnail({
  item,
}: {
  item: MediaItem;
}) {
  const source = localAssetUrl(item.thumbnailPath ?? item.path);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [source]);

  return source && !failed ? (
    <img
      src={source}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  ) : (
    <Icon name={item.kind === "gif" ? "play" : "image"} />
  );
});

export function FavoriteSitesPage() {
  const [sites, setSites] = useState<FavoriteSite[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void getJsonPreference<unknown>(SITE_KEY, []).then((result) => {
      if (!active) return;
      setSites(normalizeSites(result.data));
      setError(result.error);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function save(next: FavoriteSite[]) {
    setSaving(true);
    const result = await setJsonPreference(SITE_KEY, next);
    setSaving(false);
    if (result.error || !result.data) {
      setError(result.error ?? "サイトを保存できませんでした。");
      return false;
    }
    setSites(next);
    setError(undefined);
    return true;
  }

  async function addSite() {
    const normalizedUrl = normalizeHttpUrl(url);
    if (!normalizedUrl) {
      setError("http:// または https:// のURLを入力してください。");
      return;
    }
    if (
      await save([
        ...sites,
        {
          id: makeId(),
          name: name.trim() || normalizedUrl,
          url: normalizedUrl,
          description: description.trim() || undefined,
        },
      ])
    ) {
      setName("");
      setUrl("");
      setDescription("");
    }
  }

  return (
    <div className="page utility-page">
      <PageHeader
        eyebrow="FAVORITE SITES"
        title="お気に入りサイト"
        description="よく使うサイトを、目的やメモと一緒にカードへ保存します。"
      />
      <OperationMessage error={error} />
      <section className="utility-form-card">
        <div>
          <p className="kicker">ADD SITE</p>
          <strong>サイトを登録</strong>
        </div>
        <div className="utility-form">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="サイト名"
          />
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com"
            type="url"
          />
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="メモ（任意）"
          />
          <button
            className="primary-button"
            type="button"
            onClick={() => void addSite()}
            disabled={saving || !url.trim()}
          >
            <Icon name="folderPlus" />
            追加
          </button>
        </div>
      </section>
      {loading ? (
        <LoadingPanel label="お気に入りサイトを読み込み中…" />
      ) : sites.length === 0 ? (
        <EmptyState
          icon="external"
          title="お気に入りサイトはまだありません"
          description="よく参照するサイトを登録すると、ここからすぐ開けます。"
        />
      ) : (
        <section className="favorite-site-grid">
          {sites.map((site) => (
            <article className="favorite-site-card" key={site.id}>
              <div className="utility-card-top">
                <span className="utility-icon"><Icon name="external" /></span>
                <button
                  className="card-delete"
                  type="button"
                  aria-label={`${site.name}を削除`}
                  disabled={saving}
                  onClick={() =>
                    void save(sites.filter((item) => item.id !== site.id))}
                >
                  <Icon name="trash" />
                </button>
              </div>
              <strong>{site.name}</strong>
              {site.description && <p>{site.description}</p>}
              <a href={site.url} target="_blank" rel="noreferrer">
                <span>{site.url}</span>
                <Icon name="arrowRight" />
              </a>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

export function FavoriteCreatorsPage() {
  const [creators, setCreators] = useState<FavoriteCreator[]>([]);
  const [name, setName] = useState("");
  const [linkDrafts, setLinkDrafts] = useState<CreatorLinkDraft[]>([
    newCreatorLinkDraft(),
  ]);
  const [searchTargetId, setSearchTargetId] = useState<string>();
  const [creatorDraftOpen, setCreatorDraftOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void getJsonPreference<unknown>(CREATOR_KEY, []).then((result) => {
      if (!active) return;
      setCreators(normalizeCreators(result.data));
      setError(result.error);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function save(next: FavoriteCreator[]) {
    setSaving(true);
    const result = await setJsonPreference(CREATOR_KEY, next);
    setSaving(false);
    if (result.error || !result.data) {
      setError(result.error ?? "クリエイターを保存できませんでした。");
      return false;
    }
    setCreators(next);
    setError(undefined);
    return true;
  }

  function updateDraft(id: string, update: Partial<CreatorLinkDraft>) {
    setLinkDrafts((current) =>
      current.map((draft) =>
        draft.id === id ? { ...draft, ...update } : draft),
    );
  }

  async function addCreator() {
    const creatorName = name.trim();
    if (!creatorName) {
      setError("クリエイター名を入力してください。");
      return;
    }
    const populatedDrafts = linkDrafts.filter((draft) => draft.url.trim());
    if (populatedDrafts.length === 0) {
      setError("リンクを1件以上入力してください。");
      return;
    }

    const normalizedLinks: CreatorLink[] = [];
    const seen = new Set<string>();
    for (const draft of populatedDrafts) {
      const normalizedUrl = normalizeHttpUrl(draft.url);
      if (!normalizedUrl) {
        setError("入力されたリンクに正しくないURLがあります。");
        return;
      }
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      normalizedLinks.push({
        id: makeId(),
        platform: draft.platform,
        url: normalizedUrl,
      });
    }

    const existing = creators.find(
      (creator) =>
        creator.name.toLocaleLowerCase("ja")
        === creatorName.toLocaleLowerCase("ja"),
    );
    let addedCount = normalizedLinks.length;
    const next = existing
      ? creators.map((creator) => {
          if (creator.id !== existing.id) return creator;
          const existingUrls = new Set(creator.links.map((link) => link.url));
          const uniqueLinks = normalizedLinks.filter(
            (link) => !existingUrls.has(link.url),
          );
          addedCount = uniqueLinks.length;
          return { ...creator, links: [...creator.links, ...uniqueLinks] };
        })
      : [...creators, {
          id: makeId(),
          name: creatorName,
          links: normalizedLinks,
        }];

    if (addedCount === 0) {
      setError("入力されたリンクはすべて登録済みです。");
      return;
    }

    const operation = startOperation({
      label: "クリエイターを登録中",
      detail: `${creatorName}・${addedCount}件のリンク`,
    });
    if (await save(next)) {
      setName("");
      setLinkDrafts([newCreatorLinkDraft()]);
      operation.succeed(`${addedCount}件のリンクを登録しました`);
    } else {
      operation.fail("クリエイターを保存できませんでした。");
    }
  }

  function applyCreatorSearchResult(result: WebSearchResult) {
    if (!searchTargetId) return;
    const normalizedUrl = normalizeHttpUrl(result.url);
    if (!normalizedUrl) {
      setError("検索結果から有効なURLを取得できませんでした。");
      return;
    }
    updateDraft(searchTargetId, { url: normalizedUrl });
    setSearchTargetId(undefined);
    setError(undefined);
  }

  const searchTarget = linkDrafts.find(
    (draft) => draft.id === searchTargetId,
  );

  return (
    <div className="page utility-page">
      <PageHeader
        eyebrow="FAVORITE CREATORS"
        title="お気に入りクリエイター"
        description="1人のクリエイターに、X・pixiv・支援サイトなど複数のリンクをまとめて登録できます。"
      />
      <OperationMessage error={error} />
      <section className={`utility-form-card creator-draft-card${creatorDraftOpen ? "" : " is-collapsed"}`}>
        <div className="creator-draft-heading">
          <span className="creator-draft-heading-icon">
            <Icon name="reference" />
          </span>
          <div>
            <p className="kicker">ADD CREATOR</p>
            <strong>クリエイターを登録</strong>
            <span>サイトごとのリンクを、1人のプロフィールにまとめます。</span>
          </div>
          <button
            type="button"
            className="creator-draft-collapse"
            aria-expanded={creatorDraftOpen}
            aria-label={creatorDraftOpen ? "クリエイター登録枠を最小化" : "クリエイター登録枠を開く"}
            title={creatorDraftOpen ? "最小化" : "開く"}
            onClick={() => setCreatorDraftOpen((current) => !current)}
          >
            <Icon name={creatorDraftOpen ? "minus" : "reference"} />
          </button>
        </div>
        {creatorDraftOpen && <div className="creator-draft-form">
          <label className="extra-labelled-field creator-name-field">
            <span>クリエイター名</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例：クリエイター名"
              autoComplete="off"
            />
          </label>
          <section className="creator-link-editor">
            <header>
              <div>
                <Icon name="external" />
                <span>
                  <strong>リンク</strong>
                  <small>サイトを選び、URLを直接入力またはGoogleで検索</small>
                </span>
              </div>
              <b>{linkDrafts.length} SITES</b>
            </header>
            <div className="creator-draft-list">
              {linkDrafts.map((draft, index) => {
                const validUrl = Boolean(normalizeHttpUrl(draft.url));
                const canSearch = Boolean(name.trim()) && !draft.url.trim();
                return (
                  <div className="creator-draft-row" key={draft.id}>
                    <span className="creator-draft-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="creator-draft-field creator-draft-site">
                      <span>サイト</span>
                      <SelectMenu
                        value={draft.platform}
                        options={platformOptions}
                        onChange={(platform) => updateDraft(draft.id, { platform })}
                        ariaLabel={`${index + 1}件目のプラットフォーム`}
                        className="creator-draft-platform"
                        disabled={saving}
                      />
                    </div>
                    <label className="creator-draft-field">
                      <span>URL</span>
                      <div
                        className={`creator-draft-url ${validUrl ? "is-valid" : ""}`}
                      >
                        <input
                          value={draft.url}
                          onChange={(event) =>
                            updateDraft(draft.id, { url: event.target.value })}
                          placeholder="https://..."
                          type="url"
                          aria-label={`${index + 1}件目のリンクURL`}
                        />
                        {validUrl && (
                          <span
                            className="creator-draft-validation"
                            title="有効なURLです"
                          >
                            <Icon name="check" />
                          </span>
                        )}
                      </div>
                    </label>
                    <button
                      className="creator-search-button"
                      type="button"
                      onClick={() => setSearchTargetId(draft.id)}
                      disabled={saving || !canSearch}
                      title={
                        draft.url.trim()
                          ? "リンク欄を空にするとGoogle検索を使えます"
                          : !name.trim()
                            ? "先にクリエイター名を入力してください"
                            : `${name.trim()} ${draft.platform} をGoogleで検索`
                      }
                    >
                      <span aria-hidden="true">G</span>
                      <Icon name="search" />
                      <small>Google検索</small>
                    </button>
                    <button
                      className="icon-button creator-remove-row"
                      type="button"
                      aria-label={`${index + 1}件目のリンク欄を削除`}
                      disabled={saving || linkDrafts.length === 1}
                      onClick={() =>
                        setLinkDrafts((current) =>
                          current.filter((item) => item.id !== draft.id))}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              className="creator-add-link-row"
              type="button"
              onClick={() =>
                setLinkDrafts((current) => [
                  ...current,
                  newCreatorLinkDraft(),
                ])}
              disabled={saving}
            >
              <span><Icon name="folderPlus" /></span>
              <span>
                <strong>別サイトのリンクを追加</strong>
                <small>X、pixiv、FANBOXなどをまとめて登録できます</small>
              </span>
              <Icon name="arrowRight" />
            </button>
          </section>
          <div className="creator-draft-actions">
            <span>
              入力済み
              <strong>{linkDrafts.filter((draft) => draft.url.trim()).length}</strong>
              件
            </span>
            <button
              className="primary-button"
              type="button"
              onClick={() => void addCreator()}
              disabled={
                saving ||
                !name.trim() ||
                !linkDrafts.some((draft) => draft.url.trim())
              }
            >
              <Icon name="check" />
              {linkDrafts.filter((draft) => draft.url.trim()).length}件を登録
            </button>
          </div>
        </div>}
      </section>

      {loading ? (
        <LoadingPanel label="クリエイターを読み込み中…" />
      ) : creators.length === 0 ? (
        <EmptyState
          icon="reference"
          title="お気に入りクリエイターはまだありません"
          description="名前と複数のリンクをまとめて登録できます。"
        />
      ) : (
        <section className="creator-card-grid">
          {creators.map((creator) => (
            <article className="creator-card" key={creator.id}>
              <div className="utility-card-top">
                <span className="utility-icon"><Icon name="reference" /></span>
                <button
                  className="card-delete"
                  type="button"
                  aria-label={`${creator.name}を削除`}
                  disabled={saving}
                  onClick={() =>
                    void save(
                      creators.filter((item) => item.id !== creator.id),
                    )}
                >
                  <Icon name="trash" />
                </button>
              </div>
              <strong>{creator.name}</strong>
              <span className="creator-link-count">
                {creator.links.length} リンク
              </span>
              <div className="creator-links">
                {creator.links.map((link) => (
                  <a
                    href={link.url}
                    key={link.id}
                    target="_blank"
                    rel="noreferrer"
                    title={link.url}
                  >
                    <span>{link.platform}</span>
                    <Icon name="external" />
                  </a>
                ))}
              </div>
            </article>
          ))}
        </section>
      )}

      <WebSearchModal
        open={Boolean(searchTargetId)}
        query={`${name.trim()} ${searchTarget?.platform ?? ""}`.trim()}
        mode="web"
        provider="google"
        title={`${searchTarget?.platform ?? "サイト"}のリンクを検索`}
        onClose={() => setSearchTargetId(undefined)}
        onSelect={applyCreatorSearchResult}
      />
    </div>
  );
}

export function DrawingReferencesPage() {
  const galleryPageSize = 120;
  const [projects, setProjects] = useState<ReferenceProject[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draftName, setDraftName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addMode, setAddMode] = useState<ReferenceAddMode>("choose");
  const [directUrl, setDirectUrl] = useState("");
  const [directName, setDirectName] = useState("");
  const [galleryItems, setGalleryItems] = useState<MediaItem[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryQuery, setGalleryQuery] = useState("");
  const [gallerySelection, setGallerySelection] = useState<Set<string>>(
    new Set(),
  );
  const [visibleGalleryCount, setVisibleGalleryCount] = useState(galleryPageSize);
  const [webSearchOpen, setWebSearchOpen] = useState(false);
  const deferredGalleryQuery = useDeferredValue(galleryQuery);

  useEffect(() => {
    let active = true;
    void getJsonPreference<unknown>(REFERENCE_KEY, []).then((result) => {
      if (!active) return;
      setProjects(normalizeProjects(result.data));
      setError(result.error);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!addModalOpen || addMode !== "gallery") return;
    let active = true;
    setGalleryLoading(true);
    setError(undefined);
    void listMediaItems({
      kind: ["image", "gif"],
      sortBy: "modifiedAt",
      sortDirection: "desc",
      limit: 1000,
    }).then((result) => {
      if (!active) return;
      setGalleryItems(
        result.data.filter(
          (item) => item.kind === "image" || item.kind === "gif",
        ),
      );
      setError(result.error);
      setGalleryLoading(false);
    });
    return () => {
      active = false;
    };
  }, [addModalOpen, addMode]);

  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId),
    [projects, selectedId],
  );
  const normalizedDirectUrl = useMemo(
    () => normalizeHttpUrl(directUrl),
    [directUrl],
  );
  const filteredGalleryItems = useMemo(() => {
    const query = deferredGalleryQuery.trim().toLocaleLowerCase("ja");
    if (!query) return galleryItems;
    return galleryItems.filter((item) =>
      `${item.name} ${item.relativePath ?? ""}`
        .toLocaleLowerCase("ja")
        .includes(query),
    );
  }, [deferredGalleryQuery, galleryItems]);
  const visibleGalleryItems = useMemo(
    () => filteredGalleryItems.slice(0, visibleGalleryCount),
    [filteredGalleryItems, visibleGalleryCount],
  );
  const selectedReferencePaths = useMemo(
    () => new Set(selected?.items.map((item) => item.path) ?? []),
    [selected],
  );

  async function save(next: ReferenceProject[]) {
    setSaving(true);
    const result = await setJsonPreference(REFERENCE_KEY, next);
    setSaving(false);
    if (result.error || !result.data) {
      setError(result.error ?? "資料プロジェクトを保存できませんでした。");
      return false;
    }
    setProjects(next);
    setError(undefined);
    return true;
  }

  async function createProject() {
    const name = draftName.trim();
    if (!name) return;
    const project: ReferenceProject = {
      id: makeId(),
      name,
      status: "active",
      createdAt: new Date().toISOString(),
      items: [],
    };
    const operation = startOperation({
      label: "資料プロジェクトを作成中",
      detail: name,
    });
    if (await save([...projects, project])) {
      setDraftName("");
      setShowCreate(false);
      setSelectedId(project.id);
      operation.succeed("資料プロジェクトを作成しました");
    } else {
      operation.fail("資料プロジェクトを作成できませんでした。");
    }
  }

  function openAddReferenceModal() {
    setAddMode("choose");
    setDirectUrl("");
    setDirectName("");
    setGalleryQuery("");
    setVisibleGalleryCount(galleryPageSize);
    setGallerySelection(new Set());
    setAddModalOpen(true);
  }

  function closeAddReferenceModal() {
    setAddModalOpen(false);
    setAddMode("choose");
    setGallerySelection(new Set());
  }

  async function appendReferences(
    references: DrawingReference[],
    detail: string,
  ) {
    if (!selected || selected.status !== "active") return false;
    const currentProject = projects.find(
      (project) => project.id === selected.id,
    );
    if (!currentProject) return false;

    const existingPaths = new Set(currentProject.items.map((item) => item.path));
    const additions = references.filter((reference) => {
      if (existingPaths.has(reference.path)) return false;
      existingPaths.add(reference.path);
      return true;
    });
    if (additions.length === 0) {
      setError("選択した資料はすでに追加されています。");
      return false;
    }

    const operation = startOperation({
      label: "お絵描き資料を保存中",
      detail,
    });
    const next = projects.map((project) =>
      project.id === selected.id
        ? { ...project, items: [...project.items, ...additions] }
        : project,
    );
    if (await save(next)) {
      operation.succeed(`${additions.length}件の資料を追加しました`);
      return true;
    }
    operation.fail("お絵描き資料を保存できませんでした。");
    return false;
  }

  async function addReferenceFromFile(temporary: boolean) {
    if (!selected) return;
    const picked = await pickDrawingReference();
    if (picked.error) {
      setError(picked.error);
      return;
    }
    if (!picked.data) return;
    const referenceId = makeId();
    let path = picked.data;
    if (temporary) {
      const cached = await cacheTemporaryDrawingReference(selected.id, referenceId, picked.data);
      if (cached.error || !cached.data) {
        setError(cached.error ?? "一時資料をアプリのキャッシュへコピーできませんでした。");
        return;
      }
      path = cached.data.path;
    }
    const added = await appendReferences([{
      id: referenceId,
      name: fileName(picked.data),
      path,
      source: "local",
      temporary,
      originalPath: temporary ? picked.data : undefined,
    }], fileName(picked.data));
    if (added) {
      closeAddReferenceModal();
    } else if (temporary) {
      const cleanup = await cleanupTemporaryDrawingReferences(selected.id, [path]);
      if (cleanup.error) setError(`資料を保存できず、一時キャッシュも削除できませんでした: ${cleanup.error}`);
    }
  }

  async function addDirectReference() {
    if (!normalizedDirectUrl) {
      setError("http:// または https:// のURLを入力してください。");
      return;
    }
    const added = await appendReferences([{
      id: makeId(),
      name: referenceNameFromUrl(normalizedDirectUrl, directName),
      path: normalizedDirectUrl,
      source: "url",
      previewUrl: normalizedDirectUrl,
    }], normalizedDirectUrl);
    if (added) closeAddReferenceModal();
  }

  async function addGalleryReferences() {
    const references = galleryItems
      .filter((item) => gallerySelection.has(item.id))
      .map<DrawingReference>((item) => ({
        id: makeId(),
        name: item.name,
        path: item.path,
        source: "gallery",
        mediaId: item.id,
        previewUrl: item.thumbnailPath
          ? localAssetUrl(item.thumbnailPath)
          : undefined,
      }));
    const added = await appendReferences(
      references,
      `${references.length}件をギャラリーから選択`,
    );
    if (added) closeAddReferenceModal();
  }

  async function addWebReference(result: WebSearchResult) {
    setWebSearchOpen(false);
    const url = normalizeHttpUrl(result.url);
    if (!url) {
      setError("検索結果から有効なURLを取得できませんでした。");
      return;
    }
    await appendReferences([{
      id: makeId(),
      name: referenceNameFromUrl(url, result.title),
      path: url,
      source: "web",
      previewUrl: result.thumbnailUrl
        ? normalizeHttpUrl(result.thumbnailUrl)
        : undefined,
    }], result.title || url);
  }

  async function toggleStatus(project: ReferenceProject) {
    const finishing = project.status === "active";
    const temporaryItems = finishing
      ? project.items.filter((reference) => reference.temporary)
      : [];
    if (temporaryItems.length > 0 && !window.confirm(
      `完了すると、一時資料${temporaryItems.length}件をアプリのキャッシュから削除します。続けますか？`,
    )) return;
    const operation = startOperation({
      label: finishing ? "プロジェクトを完了中" : "制作を再開中",
      detail: project.name,
    });
    const next = projects.map((item) =>
      item.id === project.id
        ? {
            ...item,
            status: finishing ? "finished" as const : "active" as const,
            items: finishing
              ? item.items.filter((reference) => !reference.temporary)
              : item.items,
          }
        : item,
    );
    if (await save(next)) {
      if (temporaryItems.length > 0) {
        const cleanup = await cleanupTemporaryDrawingReferences(
          project.id,
          temporaryItems.map((reference) => reference.path),
        );
        if (cleanup.error) {
          setError(`プロジェクトは完了しましたが、一時資料のキャッシュを削除できませんでした: ${cleanup.error}`);
          operation.fail("一時資料のキャッシュ整理に失敗しました。");
          return;
        }
      }
      operation.succeed(
        finishing
          ? temporaryItems.length > 0
            ? `完了済みに移動し、一時資料${temporaryItems.length}件を削除しました`
            : "完了済みに移動しました"
          : "制作中に戻しました",
      );
    } else {
      operation.fail("プロジェクトの状態を変更できませんでした。");
    }
  }

  async function removeReference(reference: DrawingReference) {
    if (!selected) return;
    const next = projects.map((project) => project.id === selected.id
      ? { ...project, items: project.items.filter((item) => item.id !== reference.id) }
      : project);
    if (!await save(next) || !reference.temporary) return;
    const cleanup = await cleanupTemporaryDrawingReferences(selected.id, [reference.path]);
    if (cleanup.error) setError(`資料は一覧から削除しましたが、一時キャッシュを削除できませんでした: ${cleanup.error}`);
  }

  async function deleteProject(project: ReferenceProject) {
    const temporaryPaths = project.items
      .filter((reference) => reference.temporary)
      .map((reference) => reference.path);
    if (!await save(projects.filter((item) => item.id !== project.id))) return;
    if (selectedId === project.id) setSelectedId(undefined);
    if (temporaryPaths.length === 0) return;
    const cleanup = await cleanupTemporaryDrawingReferences(project.id, temporaryPaths);
    if (cleanup.error) setError(`プロジェクトは削除しましたが、一時キャッシュを削除できませんでした: ${cleanup.error}`);
  }

  function toggleGalleryItem(item: MediaItem) {
    if (selectedReferencePaths.has(item.path)) return;
    setGallerySelection((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  if (selected) {
    const directPreview: DrawingReference | undefined = normalizedDirectUrl
      ? {
          id: "direct-preview",
          name: referenceNameFromUrl(normalizedDirectUrl, directName),
          path: normalizedDirectUrl,
          source: "url",
          previewUrl: normalizedDirectUrl,
        }
      : undefined;
    return (
      <div className="page utility-page">
        <PageHeader
          eyebrow="DRAWING REFERENCES"
          title={selected.name}
          description={
            selected.status === "finished"
              ? "完了済みの資料プロジェクトです。必要なら制作を再開できます。"
              : "制作中に参照する画像やWeb資料をここへまとめます。"
          }
          actions={(
            <div className="page-actions">
              <button
                className="secondary-button back-button"
                type="button"
                onClick={() => setSelectedId(undefined)}
              >
                <Icon name="arrowRight" />
                プロジェクト一覧
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={openAddReferenceModal}
                disabled={saving || selected.status === "finished"}
                title={
                  selected.status === "finished"
                    ? "資料を追加するには制作を再開してください"
                    : undefined
                }
              >
                <Icon name="folderPlus" />
                資料を追加
              </button>
            </div>
          )}
        />
        <OperationMessage error={error} />
        <section
          className={`reference-state-card is-${selected.status}`}
          aria-label="プロジェクトの状態"
        >
          <span className="reference-state-icon">
            <Icon name={selected.status === "active" ? "reference" : "check"} />
          </span>
          <div>
            <p>{selected.status === "active" ? "IN PROGRESS" : "COMPLETED"}</p>
            <strong>
              {selected.status === "active" ? "制作中" : "完了済み"}
            </strong>
            <span>
              {selected.status === "active"
                ? "制作が終わったら、右のボタンで完了済みに整理できます。"
                : "資料は読み取り専用です。追加・編集する場合は制作を再開してください。"}
            </span>
          </div>
          <button
            className={
              selected.status === "active"
                ? "primary-button reference-state-action"
                : "secondary-button reference-state-action"
            }
            type="button"
            onClick={() => void toggleStatus(selected)}
            disabled={saving}
          >
            <Icon
              name={selected.status === "active" ? "check" : "reference"}
            />
            {selected.status === "active" ? "完了にする" : "制作を再開"}
          </button>
        </section>

        {selected.items.length === 0 ? (
          <EmptyState
            icon="reference"
            title="資料はまだありません"
            description="「資料を追加」からURL・ファイル・ギャラリー・Web検索を選べます。"
          />
        ) : (
          <div className="reference-grid project-reference-grid">
            {selected.items.map((reference) => (
              <article key={reference.id}>
                <div className="reference-visual">
                  <ReferenceThumbnail reference={reference} />
                  <span className="reference-source-badge">
                    {reference.temporary
                      ? "一時資料"
                      : reference.source === "gallery"
                      ? "ギャラリー"
                      : reference.source === "web"
                        ? "Web検索"
                        : reference.source === "url"
                          ? "URL"
                          : "ファイル"}
                  </span>
                </div>
                <strong>{reference.name}</strong>
                {isHttpUrl(reference.path) ? (
                  <a
                    className="reference-path-link"
                    href={reference.path}
                    target="_blank"
                    rel="noreferrer"
                    title={reference.path}
                  >
                    {reference.path}
                    <Icon name="external" />
                  </a>
                ) : (
                  <span title={reference.path}>{reference.path}</span>
                )}
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => void removeReference(reference)}
                  disabled={saving || selected.status === "finished"}
                >
                  削除
                </button>
              </article>
            ))}
          </div>
        )}

        <ExtraModal
          open={addModalOpen}
          title={
            addMode === "choose"
              ? "資料の追加方法を選択"
              : addMode === "url"
                ? "URLから資料を追加"
                : "ギャラリーから選択"
          }
          description={
            addMode === "choose"
              ? "用途に合った取り込み方法を選んでください。"
              : addMode === "gallery"
                ? "登録済みの画像・GIFを複数選択できます。"
                : "URLを正規化してプロジェクトへ保存します。"
          }
          wide={addMode === "gallery"}
          onClose={closeAddReferenceModal}
          footer={
            addMode === "url" ? (
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setAddMode("choose")}
                >
                  戻る
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void addDirectReference()}
                  disabled={saving || !normalizedDirectUrl}
                >
                  <Icon name="check" />
                  URL資料を追加
                </button>
              </>
            ) : addMode === "gallery" ? (
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setAddMode("choose")}
                >
                  戻る
                </button>
                <div className="extra-modal-selection-actions">
                  <span>{gallerySelection.size}件を選択中</span>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void addGalleryReferences()}
                    disabled={saving || gallerySelection.size === 0}
                  >
                    <Icon name="check" />
                    選択した資料を追加
                  </button>
                </div>
              </>
            ) : undefined
          }
        >
          {addMode === "choose" ? (
            <div className="reference-source-options">
              <button type="button" onClick={() => setAddMode("url")}>
                <span><Icon name="external" /></span>
                <strong>URLを直接入力</strong>
                <small>画像や参考ページのURLを保存</small>
                <Icon name="arrowRight" />
              </button>
              <button
                type="button"
                onClick={() => void addReferenceFromFile(true)}
                disabled={saving}
              >
                <span><Icon name="folderPlus" /></span>
                <strong>一時ファイルを追加</strong>
                <small>アプリのキャッシュへコピーし、完了時に削除</small>
                <Icon name="arrowRight" />
              </button>
              <button
                type="button"
                onClick={() => void addReferenceFromFile(false)}
                disabled={saving}
              >
                <span><Icon name="file" /></span>
                <strong>元ファイルを参照</strong>
                <small>PC内の画像を移動・削除せず、その場所から表示</small>
                <Icon name="arrowRight" />
              </button>
              <button type="button" onClick={() => setAddMode("gallery")}>
                <span><Icon name="gallery" /></span>
                <strong>ギャラリーから選択</strong>
                <small>登録済み画像・GIFを複数追加</small>
                <Icon name="arrowRight" />
              </button>
              <button
                type="button"
                onClick={() => {
                  closeAddReferenceModal();
                  setWebSearchOpen(true);
                }}
              >
                <span><Icon name="search" /></span>
                <strong>Web検索</strong>
                <small>Webで資料を探してURLを保存</small>
                <Icon name="arrowRight" />
              </button>
            </div>
          ) : addMode === "url" ? (
            <div className="reference-url-form">
              <label className="extra-labelled-field">
                <span>資料URL</span>
                <input
                  autoFocus
                  value={directUrl}
                  onChange={(event) => setDirectUrl(event.target.value)}
                  placeholder="https://example.com/reference.jpg"
                  type="url"
                />
                {directUrl.trim() && !normalizedDirectUrl && (
                  <small className="field-error">
                    http:// または https:// のURLを入力してください。
                  </small>
                )}
              </label>
              <label className="extra-labelled-field">
                <span>表示名（任意）</span>
                <input
                  value={directName}
                  onChange={(event) => setDirectName(event.target.value)}
                  placeholder="空欄の場合はURLから自動設定"
                />
              </label>
              <div className="reference-url-preview">
                <span>PREVIEW</span>
                <div>
                  {directPreview ? (
                    <ReferenceThumbnail reference={directPreview} />
                  ) : (
                    <div className="reference-preview-fallback">
                      <Icon name="image" />
                      <span>URLを入力するとプレビューします</span>
                    </div>
                  )}
                </div>
                {normalizedDirectUrl && (
                  <small>{normalizedDirectUrl}</small>
                )}
              </div>
            </div>
          ) : (
            <div className="reference-gallery-picker">
              <label className="reference-gallery-search">
                <Icon name="search" />
                <input
                  value={galleryQuery}
                  onChange={(event) => {
                    setGalleryQuery(event.target.value);
                    setVisibleGalleryCount(galleryPageSize);
                  }}
                  placeholder="画像・GIFを絞り込み"
                  autoFocus
                />
              </label>
              {galleryLoading ? (
                <LoadingPanel label="ギャラリーを読み込み中…" />
              ) : filteredGalleryItems.length === 0 ? (
                <EmptyState
                  icon="gallery"
                  title="選択できる画像・GIFがありません"
                  description={
                    galleryQuery
                      ? "検索条件を変えてください。"
                      : "先にギャラリーへ画像またはGIFを登録してください。"
                  }
                />
              ) : (
                <>
                <div className="reference-gallery-grid">
                  {visibleGalleryItems.map((item) => {
                    const alreadyAdded = selectedReferencePaths.has(item.path);
                    const checked = gallerySelection.has(item.id);
                    return (
                      <button
                        type="button"
                        className={`${checked ? "is-selected" : ""} ${alreadyAdded ? "is-added" : ""}`}
                        aria-pressed={checked}
                        disabled={alreadyAdded}
                        onClick={() => toggleGalleryItem(item)}
                        key={item.id}
                      >
                        <span className="reference-gallery-visual">
                          <GalleryItemThumbnail item={item} />
                          <b>{item.kind === "gif" ? "GIF" : "画像"}</b>
                          <i>
                            <Icon name={alreadyAdded || checked ? "check" : "image"} />
                          </i>
                        </span>
                        <strong>{item.name}</strong>
                        <small>
                          {alreadyAdded ? "追加済み" : item.relativePath ?? item.path}
                        </small>
                      </button>
                    );
                  })}
                </div>
                {visibleGalleryItems.length < filteredGalleryItems.length && (
                  <button
                    className="reference-gallery-more"
                    type="button"
                    onClick={() => setVisibleGalleryCount((count) => (
                      Math.min(filteredGalleryItems.length, count + galleryPageSize)
                    ))}
                  >
                    <Icon name="chevronDown" />
                    次の{Math.min(
                      galleryPageSize,
                      filteredGalleryItems.length - visibleGalleryItems.length,
                    )}件を表示
                    <small>
                      {visibleGalleryItems.length} / {filteredGalleryItems.length}
                    </small>
                  </button>
                )}
                </>
              )}
            </div>
          )}
        </ExtraModal>

        <WebSearchModal
          open={webSearchOpen}
          query={selected.name}
          mode="image"
          title="お絵描き資料をWeb検索"
          onClose={() => setWebSearchOpen(false)}
          onSelect={(result) => void addWebReference(result)}
        />
      </div>
    );
  }

  return (
    <div className="page utility-page">
      <PageHeader
        eyebrow="DRAWING REFERENCES"
        title="お絵描き資料"
        description="制作ごとに資料をまとめ、制作中と完了済みを分けて管理します。"
        actions={(
          <button
            className="primary-button"
            type="button"
            onClick={() => setShowCreate((current) => !current)}
          >
            <Icon name="folderPlus" />
            新規プロジェクト
          </button>
        )}
      />
      <OperationMessage error={error} />
      {showCreate && (
        <section className="utility-form-card compact">
          <div>
            <p className="kicker">NEW PROJECT</p>
            <strong>資料プロジェクトを作成</strong>
          </div>
          <div className="utility-form">
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="例: 夏服のキャラクター"
              onKeyDown={(event) => {
                if (event.key === "Enter") void createProject();
              }}
            />
            <button
              className="primary-button"
              type="button"
              onClick={() => void createProject()}
              disabled={saving || !draftName.trim()}
            >
              作成
            </button>
          </div>
        </section>
      )}
      {loading ? (
        <LoadingPanel label="資料プロジェクトを読み込み中…" />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="reference"
          title="資料プロジェクトはまだありません"
          description="新規プロジェクトを作成して、制作中の資料をまとめましょう。"
        />
      ) : (
        <section className="reference-project-list">
          {projects.map((project) => (
            <article
              className={`reference-project-card is-${project.status}`}
              key={project.id}
            >
              <button
                type="button"
                className="reference-project-open"
                onClick={() => setSelectedId(project.id)}
              >
                <div className="reference-project-title">
                  <span
                    className={
                      project.status === "active"
                        ? "utility-icon"
                        : "utility-icon muted"
                    }
                  >
                    <Icon
                      name={project.status === "active" ? "reference" : "check"}
                    />
                  </span>
                  <div>
                    <strong>{project.name}</strong>
                    <span>
                      {project.status === "active" ? "制作中" : "完了済み"}
                    </span>
                  </div>
                </div>
                <div className="reference-preview-row">
                  {project.items.length === 0 ? (
                    <span className="reference-empty-preview">
                      資料はまだありません
                    </span>
                  ) : (
                    project.items.slice(0, 4).map((item) => (
                      <span key={item.id}>
                        <ReferenceThumbnail reference={item} />
                      </span>
                    ))
                  )}
                  {project.items.length > 4 && (
                    <b>+{project.items.length - 4}</b>
                  )}
                </div>
              </button>
              <div className="reference-project-actions">
                <span>{project.items.length} 件の資料</span>
                <button
                  className="secondary-button reference-list-status-button"
                  type="button"
                  disabled={saving}
                  onClick={() => void toggleStatus(project)}
                >
                  <Icon
                    name={project.status === "active" ? "check" : "reference"}
                  />
                  {project.status === "active" ? "完了にする" : "制作を再開"}
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="プロジェクトを削除"
                  disabled={saving}
                  onClick={() => {
                    if (window.confirm(`「${project.name}」を削除しますか？`)) {
                      void deleteProject(project);
                    }
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function isXPostUrl(value: string) {
  return /^https:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/.+\/status\/\d+(?:[/?#]|$)/i.test(
    value,
  );
}

function isVideoDownloadPath(value: string) {
  return /\.(?:mp4|m4v|mov|webm)(?:[?#]|$)/i.test(value);
}

async function finalizeDownloadedXGifs(
  media: XDownloadedMedia[],
  operation: OperationHandle,
) {
  const gifDownloads = media.filter(
    (item) => item.kind === "gif" && item.gifFinalizeToken,
  );
  const errors: string[] = [];
  let keptTemporarySource = false;
  for (let index = 0; index < gifDownloads.length; index += 1) {
    const item = gifDownloads[index];
    if (!item.gifFinalizeToken) {
      errors.push(`${index + 1}件目: GIF変換の承認情報がありません`);
      continue;
    }
    try {
      operation.update({
        label: "XのGIFを変換中",
        detail: `${index + 1} / ${gifDownloads.length}件目をネイティブ変換しています`,
        progress: Math.round((index / gifDownloads.length) * 100),
      });
      const finalized = await finalizeXGif(item.gifFinalizeToken);
      if (!finalized.data || finalized.error) {
        throw new Error(finalized.error ?? "変換したGIFを保存できませんでした");
      }
      keptTemporarySource ||= !finalized.data.removedSource;
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "GIFへの変換中にエラーが発生しました";
      await failXGifFinalization(item.gifFinalizeToken, message);
      errors.push(`${index + 1}件目: ${message}`);
    }
  }
  return { errors, keptTemporarySource };
}

type XDownloaderPageProps = {
  initialUrl?: string;
  onInitialUrlConsumed?: () => void;
};

export function XDownloaderPage({ initialUrl, onInitialUrlConsumed }: XDownloaderPageProps) {
  const [url, setUrl] = useState("");
  const [history, setHistory] = useState<XHistoryItem[]>([]);
  const [destination, setDestination] = useState("");
  const [inspection, setInspection] = useState<XPostInspection>();
  const [selections, setSelections] = useState<
    Record<string, { selected: boolean; variantId: string }>
  >({});
  const [loading, setLoading] = useState(true);
  const [inspecting, setInspecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingHistoryId, setDeletingHistoryId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void Promise.all([
      listXHistory(),
      getJsonPreference<string>(X_DOWNLOAD_DIRECTORY_KEY, ""),
      getDefaultXDownloadDirectory(),
    ]).then(([historyResult, preference, defaultDirectory]) => {
      if (!active) return;
      setHistory(historyResult.data);
      setDestination(preference.data.trim() || defaultDirectory.data);
      setError(historyResult.error || preference.error || defaultDirectory.error);
      setLoading(false);
    });
    const synchronizeDestination = (event: Event) => {
      const nextDestination = (event as CustomEvent<unknown>).detail;
      if (typeof nextDestination === "string") {
        setDestination(nextDestination);
      }
    };
    window.addEventListener(
      X_DOWNLOAD_DIRECTORY_CHANGED_EVENT,
      synchronizeDestination,
    );
    return () => {
      active = false;
      window.removeEventListener(
        X_DOWNLOAD_DIRECTORY_CHANGED_EVENT,
        synchronizeDestination,
      );
    };
  }, []);

  useEffect(() => {
    if (loading || !initialUrl || !isXPostUrl(initialUrl)) return;
    setUrl(initialUrl);
    setInspection(undefined);
    setSelections({});
    onInitialUrlConsumed?.();
    void inspectUrl(initialUrl);
  }, [initialUrl, loading]);

  async function refreshHistory() {
    const refreshed = await listXHistory();
    setHistory(refreshed.data);
    return refreshed;
  }

  async function removeHistoryItem(item: XHistoryItem) {
    if (!window.confirm("この履歴を削除しますか？ 保存済みのファイルは削除されません。")) return;
    setDeletingHistoryId(item.id);
    setError(undefined);
    const result = await deleteXHistory(item.id);
    setDeletingHistoryId(undefined);
    if (!result.data || result.error) {
      setError(result.error ?? "Xダウンロード履歴を削除できませんでした。");
      return;
    }
    setHistory((current) => current.filter((candidate) => candidate.id !== item.id));
  }

  async function inspectUrl(sourceUrl = url) {
    const trimmedUrl = sourceUrl.trim();
    if (!isXPostUrl(trimmedUrl)) {
      setError("X（旧Twitter）の投稿URLを入力してください。");
      return;
    }
    const operation = startOperation({
      label: "X投稿を解析中",
      detail: "画像・GIF・動画と利用可能な画質を確認しています",
      progress: null,
    });
    setInspecting(true);
    setError(undefined);
    setInspection(undefined);
    const result = await inspectXPost(trimmedUrl, destination);
    setInspecting(false);
    if (!result.data || result.error) {
      const message =
        result.error ??
        (result.available
          ? "投稿内のメディアを解析できませんでした。"
          : "Xダウンロードはインストール版アプリで利用できます。");
      setError(message);
      operation.fail(message);
      return;
    }
    const initialSelections = Object.fromEntries(
      result.data.media.map((item) => [
        item.id,
        {
          selected: !item.alreadyDownloaded,
          variantId: item.variants[0]?.id ?? "",
        },
      ]),
    );
    setInspection(result.data);
    setSelections(initialSelections);
    const duplicateCount = result.data.media.filter(
      (item) => item.alreadyDownloaded,
    ).length;
    operation.succeed(
      duplicateCount > 0
        ? `${result.data.media.length}件を確認（保存済み${duplicateCount}件）`
        : `${result.data.media.length}件のメディアを確認しました`,
    );
  }

  async function downloadSelected() {
    if (!inspection) {
      setError("先に投稿を解析して、ダウンロードするメディアを選択してください。");
      return;
    }
    if (!destination) {
      setError("Xメディアの保存先を確認できませんでした。保存先を選択してください。");
      return;
    }
    const selected: XMediaSelection[] = inspection.media.flatMap((item) => {
      const selection = selections[item.id];
      return selection?.selected && selection.variantId
        ? [{ mediaId: item.id, variantId: selection.variantId }]
        : [];
    });
    if (selected.length === 0) {
      setError("ダウンロードする画像・GIF・動画を1件以上選択してください。");
      return;
    }
    const operation = startOperation({
      label: "X投稿をダウンロード中",
      detail: `${selected.length}件の選択内容を再確認して保存しています`,
      progress: null,
    });
    setSaving(true);
    setError(undefined);
    const result = await downloadXPost(
      inspection.sourceUrl,
      destination,
      selected,
    );
    if (!result.data || result.error) {
      setSaving(false);
      const message = result.error ?? "Xメディアをダウンロードできませんでした。";
      setError(message);
      await refreshHistory();
      operation.fail(message);
      return;
    }
    const conversion = await finalizeDownloadedXGifs(
      result.data.media,
      operation,
    );
    setSaving(false);
    const refreshed = await refreshHistory();
    if (conversion.errors.length > 0) {
      const message = `GIF ${conversion.errors.length}件を変換できませんでした。${conversion.errors.join(" / ")}`;
      setError(message);
      operation.fail(message);
      return;
    }
    if (refreshed.error) {
      setHistory((current) => [
        result.data!.history,
        ...current.filter((item) => item.id !== result.data!.history.id),
      ]);
    }
    setUrl("");
    setInspection(undefined);
    setSelections({});
    setError(undefined);
    const duplicateSuffix = result.data.duplicateCount > 0
      ? `（保存済み${result.data.duplicateCount}件は省略）`
      : "";
    operation.succeed(
      conversion.keptTemporarySource
        ? `${result.data.mediaCount}件を保存しました（一時動画を削除できなかったGIFがあります）${duplicateSuffix}`
        : result.data.mediaCount > 0
          ? `${result.data.mediaCount}件のメディアを保存しました${duplicateSuffix}`
          : `選択した${result.data.duplicateCount}件は保存済みでした`,
    );
  }

  const selectedCount = inspection?.media.reduce(
    (count, item) => count + (selections[item.id]?.selected ? 1 : 0),
    0,
  ) ?? 0;
  const selectableCount = inspection?.media.filter(
    (item) => !item.alreadyDownloaded,
  ).length ?? 0;

  return (
    <div className="page utility-page">
      <PageHeader
        eyebrow="X DOWNLOADER"
        title="X ダウンローダー"
        description="公開投稿を解析し、画像・GIF・動画と画質を選んで指定フォルダーへ保存できます。"
      />
      <OperationMessage error={error} />
      <XDownloadDirectorySetting compact />
      <section className="utility-form-card compact x-download-url-card">
        <div>
          <p className="kicker">POST URL</p>
          <strong>投稿を追加</strong>
        </div>
        <div className="utility-form">
          <input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setInspection(undefined);
              setSelections({});
            }}
            placeholder="https://x.com/.../status/..."
            type="url"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !inspecting && url.trim()) {
                event.preventDefault();
                void inspectUrl();
              }
            }}
          />
          <button
            className="primary-button"
            type="button"
            onClick={() => void inspectUrl()}
            disabled={saving || inspecting || loading || !url.trim()}
          >
            <Icon name="search" />
            {inspecting ? "解析中…" : "メディアを確認"}
          </button>
        </div>
        <p className="x-download-network-note">
          <Icon name="info" />
          Xの埋め込みAPIで取得できない公開・センシティブ投稿は、
          投稿の数値IDだけを api.fxtwitter.com へ送って解析します。
          ダウンロード先は引き続き twimg.com のメディアだけに制限されます。
          GIFは選択した最高画質MP4から最大1280px・高品質減色で再構成します。
        </p>
      </section>
      {inspection && (
        <section className="extra-panel x-media-selection-panel">
          <header className="x-selection-header">
            <div>
              <p className="kicker">SELECT MEDIA</p>
              <strong>
                @{inspection.author.replace(/^@/, "")} · {inspection.media.length}件
              </strong>
              {inspection.postText && <p>{inspection.postText}</p>}
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                const selectAll = selectedCount !== selectableCount;
                setSelections((current) =>
                  Object.fromEntries(
                    inspection.media.map((item) => [
                      item.id,
                      {
                        selected: item.alreadyDownloaded ? false : selectAll,
                        variantId:
                          current[item.id]?.variantId ??
                          item.variants[0]?.id ??
                          "",
                      },
                    ]),
                  ),
                );
              }}
            >
              <Icon name={selectedCount === selectableCount ? "close" : "check"} />
              {selectedCount === selectableCount ? "すべて解除" : "すべて選択"}
            </button>
          </header>
          <div className="x-media-choice-grid">
            {inspection.media.map((item, index) => {
              const selection = selections[item.id];
              const selected = Boolean(selection?.selected);
              const kindLabel =
                item.kind === "image"
                  ? "画像"
                  : item.kind === "gif"
                    ? "GIF"
                    : "動画";
              return (
                <article
                  className={`x-media-choice ${selected ? "is-selected" : ""} ${item.alreadyDownloaded ? "is-duplicate" : ""}`}
                  key={item.id}
                >
                  <button
                    className="x-media-preview"
                    type="button"
                    aria-pressed={selected}
                    disabled={item.alreadyDownloaded}
                    aria-label={`${index + 1}件目の${kindLabel}を${selected ? "選択解除" : "選択"}`}
                    onClick={() =>
                      setSelections((current) => ({
                        ...current,
                        [item.id]: {
                          selected: !current[item.id]?.selected,
                          variantId:
                            current[item.id]?.variantId ??
                            item.variants[0]?.id ??
                            "",
                        },
                      }))
                    }
                  >
                    {item.previewUrl ? (
                      <img
                        src={item.previewUrl}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(event) => {
                          event.currentTarget.hidden = true;
                        }}
                      />
                    ) : (
                      <span className="x-media-preview-placeholder">
                        <Icon name={item.kind === "image" ? "image" : "video"} />
                      </span>
                    )}
                    <span className="x-media-order">{index + 1}</span>
                    <span className={`x-kind-label ${item.kind}`}>{kindLabel}</span>
                    {item.alreadyDownloaded && (
                      <span className="x-duplicate-label">保存済み</span>
                    )}
                    <span className="x-selection-check" aria-hidden="true">
                      {selected && <Icon name="check" />}
                    </span>
                  </button>
                  <div className="x-media-choice-body">
                    <div>
                      <strong>{kindLabel}</strong>
                      <small>
                        {item.width && item.height
                          ? `${item.width} × ${item.height}`
                          : `${item.variants.length}画質`}
                      </small>
                    </div>
                    <SelectMenu
                      className="x-quality-select"
                      ariaLabel={`${index + 1}件目の画質`}
                      value={selection?.variantId ?? item.variants[0]?.id ?? ""}
                      options={item.variants.map((variant) => ({
                        value: variant.id,
                        label: variant.label,
                        description: variant.extension.toUpperCase(),
                      }))}
                      onChange={(variantId) =>
                        setSelections((current) => ({
                          ...current,
                          [item.id]: {
                            selected: current[item.id]?.selected ?? true,
                            variantId,
                          },
                        }))
                      }
                      disabled={item.alreadyDownloaded}
                    />
                  </div>
                </article>
              );
            })}
          </div>
          <footer className="x-selection-footer">
            <span>
              <strong>{selectedCount}件</strong>を選択中
            </span>
            <button
              className="primary-button"
              type="button"
              disabled={saving || selectedCount === 0 || !destination}
              onClick={() => void downloadSelected()}
            >
              <Icon name="download" />
              {saving ? "保存中…" : "選択したメディアをダウンロード"}
            </button>
          </footer>
        </section>
      )}
      <section className="extra-panel">
        <p className="kicker">HISTORY</p>
        {loading ? (
          <LoadingPanel label="履歴を読み込み中…" />
        ) : history.length === 0 ? (
          <EmptyState
            icon="download"
            title="履歴はまだありません"
            description="公開されているX投稿のURLを入力すると、保存結果をここに表示します。"
          />
        ) : (
          <div className="saved-link-list">
            {history.map((item) => {
              const previewUrl =
                localAssetUrl(item.savedPath) ?? item.previewUrl;
              const isVideo = isVideoDownloadPath(
                item.savedPath ?? item.previewUrl ?? "",
              );
              return (
              <article className="x-history-item" key={item.id}>
                <div className="x-history-preview">
                  {previewUrl ? (
                    isVideo ? (
                      <video
                        src={previewUrl}
                        controls
                        muted
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      <img src={previewUrl} alt="" loading="lazy" />
                    )
                  ) : (
                    <Icon name="download" />
                  )}
                </div>
                <div>
                  <strong>
                    {item.status === "saved"
                      ? "保存済み"
                      : item.status === "failed"
                        ? "失敗"
                        : "処理中"}
                  </strong>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.url}
                  </a>
                  {item.author && <small>@{item.author}</small>}
                  {item.savedPath && (
                    <small title={item.savedPath}>{item.savedPath}</small>
                  )}
                  {item.error && <small className="error-text">{item.error}</small>}
                </div>
                <div className="x-history-actions">
                  <span className={`history-state ${item.status}`}>
                    {item.status === "saved"
                      ? "保存済み"
                      : item.status === "failed"
                        ? "失敗"
                        : "処理中"}
                  </span>
                  <button
                    type="button"
                    className="x-history-delete"
                    aria-label="この履歴を削除"
                    title="履歴を削除（保存ファイルは残します）"
                    disabled={deletingHistoryId === item.id}
                    onClick={() => void removeHistoryItem(item)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
