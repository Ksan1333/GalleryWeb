import { useEffect, useMemo, useState } from "react";

import {
  deleteFolderGroup,
  listFolderGroups,
  listMediaFolders,
  reorderFolderGroups,
  saveFolderGroup,
  type FolderGroup,
  type FolderGroupMemberInput,
  type LibraryRoot,
} from "../services/native";
import { Icon } from "./Icon";

type FolderChoice = FolderGroupMemberInput & {
  key: string;
  displayName: string;
  rootName: string;
};

function memberKey(rootId: string, relativeFolder: string): string {
  return `${rootId}\0${relativeFolder.toLocaleLowerCase("ja")}`;
}

export function FolderGroupsPanel({
  roots,
  onOpenFolder,
}: {
  roots: LibraryRoot[];
  onOpenFolder: (rootId: string, relativeFolder: string) => void;
}) {
  const [groups, setGroups] = useState<FolderGroup[]>([]);
  const [choices, setChoices] = useState<FolderChoice[]>([]);
  const [editing, setEditing] = useState<FolderGroup | "new">();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingChoices, setLoadingChoices] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();

  async function refreshGroups() {
    const response = await listFolderGroups();
    setGroups(response.data);
    setError(response.error);
    setLoading(false);
  }

  useEffect(() => { void refreshGroups(); }, []);

  async function openEditor(group: FolderGroup | "new") {
    setEditing(group);
    setName(group === "new" ? `フォルダーグループ ${groups.length + 1}` : group.name);
    setSelected(new Set(group === "new"
      ? []
      : group.members.map((member) => memberKey(member.rootId, member.relativeFolder))));
    setSearch("");
    setError(undefined);
    setLoadingChoices(true);
    const results = await Promise.all(roots.map(async (root) => ({
      root,
      folders: await listMediaFolders(root.id),
    })));
    const nextChoices: FolderChoice[] = [];
    for (const { root, folders } of results) {
      nextChoices.push({
        rootId: root.id,
        relativeFolder: "",
        key: memberKey(root.id, ""),
        displayName: root.displayName,
        rootName: root.displayName,
      });
      for (const folder of folders.data) {
        if (!folder.relativeFolder) continue;
        nextChoices.push({
          rootId: root.id,
          relativeFolder: folder.relativeFolder,
          key: memberKey(root.id, folder.relativeFolder),
          displayName: folder.displayName,
          rootName: root.displayName,
        });
      }
      if (folders.error) setError((current) => current ?? folders.error);
    }
    setChoices(nextChoices);
    setLoadingChoices(false);
  }

  const visibleChoices = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("ja");
    return choices
      .filter((choice) => !needle || `${choice.rootName} ${choice.relativeFolder} ${choice.displayName}`
        .toLocaleLowerCase("ja")
        .includes(needle))
      .slice(0, 400);
  }, [choices, search]);

  async function save() {
    if (!editing || name.trim().length === 0 || selected.size < 2) return;
    setBusy(true);
    setError(undefined);
    const members = choices
      .filter((choice) => selected.has(choice.key))
      .map(({ rootId, relativeFolder }) => ({ rootId, relativeFolder }));
    const response = await saveFolderGroup(
      name,
      members,
      editing === "new" ? undefined : editing.id,
    );
    setBusy(false);
    if (!response.data || response.error) {
      setError(response.error ?? "フォルダーグループを保存できませんでした。");
      return;
    }
    setEditing(undefined);
    await refreshGroups();
  }

  async function remove(groupId: string) {
    if (confirmDeleteId !== groupId) {
      setConfirmDeleteId(groupId);
      return;
    }
    setBusy(true);
    setError(undefined);
    const response = await deleteFolderGroup(groupId);
    setBusy(false);
    setConfirmDeleteId(undefined);
    if (!response.data || response.error) {
      setError(response.error ?? "フォルダーグループを解除できませんでした。");
      return;
    }
    await refreshGroups();
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= groups.length) return;
    const next = [...groups];
    [next[index], next[target]] = [next[target], next[index]];
    setGroups(next);
    const response = await reorderFolderGroups(next.map((group) => group.id));
    if (response.error || !response.data) {
      setError(response.error ?? "フォルダーグループを並び替えできませんでした。");
      await refreshGroups();
    }
  }

  if (loading) {
    return <div className="folder-groups-panel is-loading"><span className="spinner" />グループを読み込み中…</div>;
  }

  return (
    <section className="folder-groups-panel" aria-labelledby="folder-groups-title">
      <header>
        <span>
          <p className="kicker">VIRTUAL FOLDERS</p>
          <h2 id="folder-groups-title">フォルダーグループ</h2>
          <small>離れた場所のフォルダーを、ファイルを移動せずひとまとめにします。</small>
        </span>
        <button className="primary-button" type="button" disabled={roots.length === 0 || busy} onClick={() => void openEditor("new")}>
          <Icon name="folderPlus" />グループを作成
        </button>
      </header>
      {error && <div className="inline-setting-message error" role="alert"><Icon name="warning" />{error}</div>}
      {groups.length === 0 ? (
        <div className="folder-groups-empty">
          <Icon name="folder" />
          <span><strong>グループはまだありません</strong><small>2件以上の登録済みフォルダーを選んで作成できます。</small></span>
        </div>
      ) : (
        <div className="folder-group-grid">
          {groups.map((group, index) => (
            <article className="folder-group-card" key={group.id}>
              <header>
                <span><Icon name="folder" /></span>
                <div><strong>{group.name}</strong><small>{group.members.length}件のフォルダー</small></div>
                <div className="folder-group-order-actions">
                  <button type="button" aria-label={`${group.name}を前へ`} disabled={busy || index === 0} onClick={() => void move(index, -1)}><Icon name="chevronRight" /></button>
                  <button type="button" aria-label={`${group.name}を後へ`} disabled={busy || index === groups.length - 1} onClick={() => void move(index, 1)}><Icon name="chevronRight" /></button>
                </div>
              </header>
              <div className="folder-group-members">
                {group.members.map((member) => (
                  <button type="button" key={memberKey(member.rootId, member.relativeFolder)} onClick={() => onOpenFolder(member.rootId, member.relativeFolder)}>
                    <Icon name="folder" />
                    <span><strong>{member.displayName}</strong><small>{member.rootName}{member.relativeFolder ? ` / ${member.relativeFolder}` : ""}</small></span>
                    <Icon name="chevronRight" />
                  </button>
                ))}
              </div>
              <footer>
                <button className="secondary-button" type="button" disabled={busy} onClick={() => void openEditor(group)}><Icon name="settings" />編集・追加</button>
                <button className="danger-button" type="button" disabled={busy} onClick={() => void remove(group.id)}>
                  <Icon name="trash" />{confirmDeleteId === group.id ? "もう一度押して解除" : "グループ解除"}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <div className="folder-group-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) setEditing(undefined);
        }}>
          <section className="folder-group-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-group-dialog-title">
            <header>
              <span><p className="kicker">FOLDER GROUP</p><h2 id="folder-group-dialog-title">{editing === "new" ? "グループを作成" : "グループを編集"}</h2></span>
              <button type="button" aria-label="閉じる" disabled={busy} onClick={() => setEditing(undefined)}><Icon name="close" /></button>
            </header>
            <label className="folder-group-name-field">
              <span>グループ名</span>
              <input type="text" maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="folder-group-search-field">
              <Icon name="search" /><span className="sr-only">フォルダーを検索</span>
              <input type="search" value={search} disabled={busy} placeholder="フォルダー名やパスを検索" onChange={(event) => setSearch(event.target.value)} />
            </label>
            <div className="folder-group-selection-summary"><strong>{selected.size}件を選択</strong><small>保存には2件以上必要です</small></div>
            <div className="folder-group-choice-list">
              {loadingChoices ? <span className="folder-group-loading"><span className="spinner" />フォルダーを読み込み中…</span> : visibleChoices.map((choice) => {
                const checked = selected.has(choice.key);
                return (
                  <label key={choice.key} className={checked ? "active" : undefined}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(choice.key)) next.delete(choice.key);
                        else next.add(choice.key);
                        return next;
                      })}
                    />
                    <Icon name={checked ? "check" : "folder"} />
                    <span><strong>{choice.displayName}</strong><small>{choice.rootName}{choice.relativeFolder ? ` / ${choice.relativeFolder}` : " / ルート"}</small></span>
                  </label>
                );
              })}
              {!loadingChoices && visibleChoices.length === 0 && <small>一致するフォルダーはありません。</small>}
            </div>
            <footer>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(undefined)}>キャンセル</button>
              <button className="primary-button" type="button" disabled={busy || loadingChoices || name.trim().length === 0 || selected.size < 2} onClick={() => void save()}>
                <Icon name="check" />{busy ? "保存中…" : "グループを保存"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}

export default FolderGroupsPanel;
