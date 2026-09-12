import { useCallback, useEffect, useRef, useState } from "react";
import { addLibraryRoot, browseFileSystem, listLibraryRoots, scanLibrary, setFolderPriority, type FileSystemListing, type LibraryRoot, type MediaItem, type MediaKind } from "../services/native";
import { navigateExplorer, parentFilePath, readExplorerHistory, rememberExplorerHistory, sameExplorerPath, stepExplorer, type ExplorerRequest } from "../services/explorerNavigation";
import { Icon } from "./Icon";
import { MediaCollection } from "./MediaCollection";
import "./FileSystemBrowser.css";

const EXPLORER_MEDIA_KINDS: MediaKind[] = ["image", "gif", "video", "pdf", "archive"];

export function FileSystemBrowser({ refreshVersion, onDataChanged, onPriorityChanged, navigationRequest, openRequest, onOpenRequestClose, onOpenRequestReady }: {
  refreshVersion: number;
  onDataChanged: () => void;
  onPriorityChanged?: () => void;
  navigationRequest?: ExplorerRequest;
  openRequest?: { requestId: string; item: MediaItem };
  onOpenRequestClose?: () => void;
  onOpenRequestReady?: () => void;
}) {
  const [navigation, setNavigation] = useState(() => {
    const previous = readExplorerHistory();
    return navigationRequest ? navigateExplorer(previous, navigationRequest.path) : previous;
  });
  const path = navigation.path;
  const [address, setAddress] = useState("");
  const [loadedListing, setListing] = useState<FileSystemListing | null>(null);
  const [visualReadyRequestId, setVisualReadyRequestId] = useState<string>();
  const seedListing = useRef<FileSystemListing | null>(null);
  const currentOpenRequest = navigationRequest && sameExplorerPath(path, navigationRequest.path) ? openRequest : undefined;
  if (currentOpenRequest?.item.rootId && currentOpenRequest.item.relativePath !== undefined) {
    const relative = currentOpenRequest.item.relativePath.replace(/\\/g, "/");
    seedListing.current = { path: path ?? null, parentPath: path ? parentFilePath(path) ?? null : null,
      rootId: currentOpenRequest.item.rootId, relativeFolder: relative.slice(0, Math.max(0, relative.lastIndexOf("/"))),
      priorityPath: null, folders: [] };
  }
  const listing = loadedListing ?? (sameExplorerPath(seedListing.current?.path ?? undefined, path) ? seedListing.current : null);
  const deferFolder = Boolean(currentOpenRequest && seedListing.current && sameExplorerPath(seedListing.current.path ?? undefined, path) && visualReadyRequestId !== currentOpenRequest.requestId);
  const [priorities, setPriorities] = useState<LibraryRoot[]>([]);
  const [loading, setLoading] = useState(false);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const handledNavigation = useRef(navigationRequest?.requestId);
  const generation = useRef(0);
  const lastRefresh = useRef(refreshVersion);
  const onChanged = useRef(onDataChanged);
  onChanged.current = onDataChanged;

  useEffect(() => { rememberExplorerHistory(navigation); }, [navigation]);
  useEffect(() => {
    if (!navigationRequest || handledNavigation.current === navigationRequest.requestId) return;
    handledNavigation.current = navigationRequest.requestId;
    setNavigation((current) => navigateExplorer(current, navigationRequest.path));
  }, [navigationRequest]);

  useEffect(() => {
    const handle = (direction: "back" | "forward") => (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{ handled?: boolean }>;
      queueMicrotask(() => {
        if (priorityBusy || event.defaultPrevented || event.detail?.handled || navigation[direction].length === 0) return;
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        event.preventDefault();
        if (event.detail) event.detail.handled = true;
        setNavigation((current) => stepExplorer(current, direction));
      });
    };
    const back = handle("back");
    const forward = handle("forward");
    window.addEventListener("pixvault:navigate-back", back);
    window.addEventListener("pixvault:navigate-forward", forward);
    return () => {
      window.removeEventListener("pixvault:navigate-back", back);
      window.removeEventListener("pixvault:navigate-forward", forward);
    };
  }, [navigation, priorityBusy]);

  const load = useCallback(async (scan = true) => {
    if (deferFolder) return;
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    const result = await browseFileSystem(path, scan);
    if (current !== generation.current) return;
    if (result.error || !result.data) {
      setError(result.error ?? "フォルダー閲覧はWindowsアプリで利用できます。");
      setListing(null);
    } else {
      setListing(result.data);
      setAddress(result.data.path ?? "");
      setRevision((value) => value + 1);
      if (scan) onChanged.current();
    }
    const roots = await listLibraryRoots();
    if (current !== generation.current) return;
    if (!roots.error) setPriorities(roots.data.filter((root) => root.isPriority));
    setLoading(false);
  }, [path, deferFolder]);

  useEffect(() => {
    setListing(null);
    void load();
    return () => { generation.current += 1; };
  }, [load]);
  useEffect(() => {
    if (lastRefresh.current === refreshVersion) return;
    lastRefresh.current = refreshVersion;
    void load(false);
  }, [refreshVersion, load]);
  // Re-check the open folder after sleep, drive reconnect, or changes made
  // while the application did not receive filesystem notifications.
  useEffect(() => {
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [load]);

  function navigate(next?: string) {
    if (priorityBusy) return;
    if (next === path) { void load(); return; }
    setNavigation((current) => navigateExplorer(current, next));
    window.dispatchEvent(new Event("pixvault:history-branch"));
  }
  async function prioritize() {
    if (!listing?.path) return;
    setPriorityBusy(true);
    setError(undefined);
    try {
      const result = await addLibraryRoot(listing.path);
      if (result.error || !result.data) throw new Error(result.error ?? "優先フォルダーを指定できませんでした。");
      // The priority setting has already changed even if the following scan fails.
      (onPriorityChanged ?? onChanged.current)();
      const scan = await scanLibrary(result.data.id);
      if (scan.error) throw new Error(scan.error);
      await load();
    } catch (caught) { setError(String(caught)); }
    finally { setPriorityBusy(false); }
  }
  async function removePriority(root: LibraryRoot) {
    setPriorityBusy(true);
    const result = await setFolderPriority(root.id, false);
    if (result.error) setError(result.error);
    else {
      (onPriorityChanged ?? onChanged.current)();
      await load(false);
    }
    setPriorityBusy(false);
  }
  return <div className="page filesystem-browser">
    <header className="filesystem-heading"><div><p className="kicker">FILE EXPLORER</p><h1>全フォルダー</h1>
      <p>ドライブからすべてのフォルダーを閲覧できます。開いた場所を読み込み、優先フォルダーは配下も先に読み込みます。</p></div></header>
    <div className="filesystem-toolbar">
      <nav className="filesystem-navigation" aria-label="フォルダー移動">
      <button type="button" className="secondary-button" disabled={!navigation.back.length || priorityBusy} onClick={() => setNavigation((current) => stepExplorer(current, "back"))}><Icon name="arrowLeft" />戻る</button>
      <button type="button" className="secondary-button" disabled={!navigation.forward.length || priorityBusy} onClick={() => setNavigation((current) => stepExplorer(current, "forward"))}><Icon name="arrowRight" />進む</button>
      <button type="button" className="secondary-button" onClick={() => navigate()} disabled={priorityBusy}><Icon name="folderWindows" />PC</button>
      <button type="button" className="secondary-button" disabled={!path || priorityBusy} onClick={() => navigate(listing?.parentPath ?? undefined)}><Icon name="arrowUp" />上へ</button>
      </nav>
      <form onSubmit={(event) => { event.preventDefault(); navigate(address.trim() || undefined); }}>
        <input aria-label="フォルダーのパス" placeholder="フォルダーのパスを入力" value={address} onChange={(event) => setAddress(event.target.value)} disabled={priorityBusy} />
        <button type="submit" className="secondary-button" disabled={priorityBusy}>開く</button>
      </form>
      <div className="filesystem-actions">
      <button type="button" className="secondary-button" onClick={() => void load()} disabled={loading || priorityBusy}><Icon name="refresh" className={loading ? "rotating" : undefined} />更新</button>
      {listing?.path && <button type="button" className="secondary-button" disabled={priorityBusy || Boolean(listing.priorityPath)} title={listing.priorityPath ?? "このフォルダーと配下を優先的に読み込む"} onClick={() => void prioritize()}><Icon name="star" />{priorityBusy ? "読み込み中…" : listing.priorityPath ? "優先読み込み対象" : "優先読み込みに追加"}</button>}
      </div>
    </div>
    {error && <div className="operation-message error" role="alert"><Icon name="warning" />{error}</div>}
    {priorities.length > 0 && <section className="filesystem-priorities" aria-label="優先読み込みフォルダー"><strong>優先読み込み</strong>
      {priorities.map((root) => <div key={root.id}><button type="button" onClick={() => navigate(root.path)} disabled={priorityBusy} title={root.path}><Icon name="folderWindows" /><span>{root.displayName}</span></button><button type="button" aria-label={`${root.displayName}の優先指定を解除`} title="優先指定だけを解除（ファイル・タグ・お気に入りは保持）" disabled={priorityBusy} onClick={() => void removePriority(root)}><Icon name="close" /></button></div>)}
    </section>}
    {loading && !listing && <p role="status">フォルダーを読み込んでいます…</p>}
    {listing && !listing.path && <div className="filesystem-drives">{listing.folders.map((folder) => <button key={folder.path} type="button" onClick={() => navigate(folder.path)}><Icon name="folderWindows" /><strong>{folder.displayName}</strong><small>{folder.path}</small></button>)}</div>}
    {listing?.rootId && <section className="filesystem-content" aria-label="フォルダーとメディア"><MediaCollection key={`${listing.rootId}:${listing.relativeFolder}`} embedded compactFileLayout advancedGallerySearch viewerIncludesAllMedia forcedSortOrder="name-asc" showLeadingFolderCounts={false}
      eyebrow="FOLDER" title={listing.path ?? "フォルダー"} description="フォルダーとメディア" kinds={EXPLORER_MEDIA_KINDS}
      openRequest={sameExplorerPath(listing.path ?? undefined, path) ? currentOpenRequest : undefined} onOpenRequestClose={onOpenRequestClose}
      deferCatalog={deferFolder || !loadedListing}
      onOpenRequestReady={() => { setVisualReadyRequestId(currentOpenRequest?.requestId); onOpenRequestReady?.(); }}
      emptyTitle="このフォルダーは空です" emptyDescription="表示できるメディアや子フォルダーがありません。"
      initialRootId={listing.rootId} initialFolderPath={listing.relativeFolder} refreshVersion={revision}
      leadingFolders={listing.folders.map((folder) => ({ key: folder.path, rootId: listing.rootId!, relativeFolder: folder.path, name: folder.displayName, displayPath: folder.path, itemCount: 0, hasChildren: true }))}
      onOpenLeadingFolder={(folder) => navigate(folder.displayPath)} onDataChanged={() => { void load(false); onChanged.current(); }} /></section>}
  </div>;
}
