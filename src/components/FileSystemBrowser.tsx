import { useCallback, useEffect, useRef, useState } from "react";
import { addLibraryRoot, browseFileSystem, listLibraryRoots, scanLibrary, setFolderPriority, type FileSystemListing, type LibraryRoot } from "../services/native";
import { Icon } from "./Icon";
import { MediaCollection } from "./MediaCollection";
import "./FileSystemBrowser.css";

export function FileSystemBrowser({ refreshVersion, onDataChanged }: { refreshVersion: number; onDataChanged: () => void }) {
  const [path, setPath] = useState<string>();
  const [address, setAddress] = useState("");
  const [listing, setListing] = useState<FileSystemListing | null>(null);
  const [priorities, setPriorities] = useState<LibraryRoot[]>([]);
  const [loading, setLoading] = useState(false);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const generation = useRef(0);
  const lastRefresh = useRef(refreshVersion);
  const onChanged = useRef(onDataChanged);
  onChanged.current = onDataChanged;

  const load = useCallback(async (scan = true) => {
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
  }, [path]);

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
    setHistory((items) => [...items, path]);
    setPath(next);
  }
  async function prioritize() {
    if (!listing?.path) return;
    setPriorityBusy(true);
    setError(undefined);
    try {
      const result = await addLibraryRoot(listing.path);
      if (result.error || !result.data) throw new Error(result.error ?? "優先フォルダーを指定できませんでした。");
      const scan = await scanLibrary(result.data.id);
      if (scan.error) throw new Error(scan.error);
      await load();
    } catch (caught) { setError(String(caught)); }
    finally { setPriorityBusy(false); }
  }
  async function removePriority(root: LibraryRoot) {
    setPriorityBusy(true);
    const result = await setFolderPriority(root.id, false);
    if (result.error) setError(result.error); else await load(false);
    setPriorityBusy(false);
  }
  return <div className="filesystem-browser">
    <header className="filesystem-heading"><div><p className="kicker">FILE EXPLORER</p><h2>全フォルダー</h2>
      <p>ドライブからすべてのフォルダーを閲覧できます。開いた場所を読み込み、優先フォルダーは配下も先に読み込みます。</p></div></header>
    <div className="filesystem-toolbar">
      <button type="button" className="secondary-button" disabled={!history.length || priorityBusy} onClick={() => { setPath(history[history.length - 1]); setHistory((items) => items.slice(0, -1)); }}><Icon name="arrowLeft" />戻る</button>
      <button type="button" className="secondary-button" onClick={() => navigate()} disabled={priorityBusy}><Icon name="folderWindows" />PC</button>
      <button type="button" className="secondary-button" disabled={!path || priorityBusy} onClick={() => navigate(listing?.parentPath ?? undefined)}><Icon name="arrowUp" />上へ</button>
      <form onSubmit={(event) => { event.preventDefault(); navigate(address.trim() || undefined); }}>
        <input aria-label="フォルダーのパス" placeholder="フォルダーのパスを入力" value={address} onChange={(event) => setAddress(event.target.value)} disabled={priorityBusy} />
        <button type="submit" className="secondary-button" disabled={priorityBusy}>開く</button>
      </form>
      <button type="button" className="secondary-button" onClick={() => void load()} disabled={loading || priorityBusy}><Icon name="refresh" className={loading ? "rotating" : undefined} />更新</button>
      {listing?.path && <button type="button" className="secondary-button" disabled={priorityBusy || Boolean(listing.priorityPath)} title={listing.priorityPath ?? "このフォルダーと配下を優先的に読み込む"} onClick={() => void prioritize()}><Icon name="star" />{priorityBusy ? "読み込み中…" : listing.priorityPath ? "優先読み込み対象" : "優先読み込みに追加"}</button>}
    </div>
    {error && <div className="operation-message error" role="alert"><Icon name="warning" />{error}</div>}
    {priorities.length > 0 && <section className="filesystem-priorities" aria-label="優先読み込みフォルダー"><strong>優先読み込み</strong>
      {priorities.map((root) => <div key={root.id}><button type="button" onClick={() => navigate(root.path)} disabled={priorityBusy} title={root.path}><Icon name="folderWindows" />{root.displayName}</button><button type="button" aria-label={`${root.displayName}の優先指定を解除`} title="優先指定だけを解除（ファイル・タグ・お気に入りは保持）" disabled={priorityBusy} onClick={() => void removePriority(root)}><Icon name="close" /></button></div>)}
    </section>}
    {loading && !listing && <p role="status">フォルダーを読み込んでいます…</p>}
    {listing && !listing.path && <div className="filesystem-drives">{listing.folders.map((folder) => <button key={folder.path} type="button" onClick={() => navigate(folder.path)}><Icon name="folderWindows" /><strong>{folder.displayName}</strong><small>{folder.path}</small></button>)}</div>}
    {listing?.rootId && <MediaCollection key={`${listing.rootId}:${listing.relativeFolder}`} embedded compactFileLayout advancedGallerySearch viewerIncludesAllMedia
      eyebrow="FOLDER" title={listing.path ?? "フォルダー"} description="フォルダーとメディア" kinds={["image", "gif", "video", "pdf", "archive"]}
      emptyTitle="このフォルダーは空です" emptyDescription="表示できるメディアや子フォルダーがありません。"
      initialRootId={listing.rootId} initialFolderPath={listing.relativeFolder} refreshVersion={revision}
      leadingFolders={listing.folders.map((folder) => ({ key: folder.path, rootId: listing.rootId!, relativeFolder: folder.path, name: folder.displayName, displayPath: folder.path, itemCount: 0, hasChildren: true }))}
      onOpenLeadingFolder={(folder) => navigate(folder.displayPath)} onDataChanged={() => { void load(false); onChanged.current(); }} />}
  </div>;
}
