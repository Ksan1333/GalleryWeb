import { useEffect, useMemo, useRef, useState } from "react";
import {
  listTags,
  upsertTag,
  type AgeRating,
  type Tag,
} from "../services/native";
import { useTagTranslations } from "../services/tagTranslations";
import { Icon } from "./Icon";
import "./BulkMediaEditor.css";

export type BulkTagMode = "add" | "replace";

export type BulkMediaEditRequest = {
  ageRating?: AgeRating;
  applyTags: boolean;
  tagIds: string[];
  tags: Tag[];
  tagMode: BulkTagMode;
};

type BulkMediaEditorProps = {
  open: boolean;
  count: number;
  busy: boolean;
  initialSection: "tags" | "details";
  onClose: () => void;
  onApply: (request: BulkMediaEditRequest) => void;
};

const ratingOptions: Array<{ value: AgeRating; label: string; detail: string }> = [
  { value: "UNRATED", label: "未選択", detail: "まだ区分を設定していない" },
  { value: "SFW", label: "健全", detail: "全年齢向け" },
  { value: "R15", label: "R-15", detail: "要注意コンテンツ" },
  { value: "R18", label: "R-18", detail: "成人向け" },
];

export function BulkMediaEditor({
  open,
  count,
  busy,
  initialSection,
  onClose,
  onApply,
}: BulkMediaEditorProps) {
  const translateTag = useTagTranslations(open);
  const dialogRef = useRef<HTMLElement>(null);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [tagMode, setTagMode] = useState<BulkTagMode>("add");
  const [applyTags, setApplyTags] = useState(false);
  const [ageRating, setAgeRating] = useState<AgeRating>();
  const [newTag, setNewTag] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setSelectedIds(new Set());
    setTagMode("add");
    setApplyTags(false);
    setAgeRating(undefined);
    setNewTag("");
    setError(undefined);
    setLoading(true);
    let active = true;
    void listTags().then((result) => {
      if (!active) return;
      setAvailableTags(result.data);
      setError(result.error);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
      )].filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKey);
      previouslyFocused?.focus();
    };
  }, [busy, onClose, open]);

  const selectedTags = useMemo(
    () => availableTags.filter((tag) => selectedIds.has(tag.id)),
    [availableTags, selectedIds],
  );

  const toggleTag = (tagId: string) => {
    setApplyTags(true);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const createTag = async () => {
    const name = newTag.trim();
    if (!name || creating || busy) return;
    setCreating(true);
    setError(undefined);
    const result = await upsertTag({ name });
    if (result.error || !result.data) {
      setError(result.error ?? "タグを作成できませんでした。");
    } else {
      const created = result.data;
      setAvailableTags((current) => (
        current.some((tag) => tag.id === created.id) ? current : [...current, created]
      ));
      setSelectedIds((current) => new Set(current).add(created.id));
      setApplyTags(true);
      setNewTag("");
    }
    setCreating(false);
  };

  if (!open) return null;

  return (
    <div
      className="bulk-media-editor-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="bulk-media-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-media-editor-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>BULK EDITOR</span>
            <h2 id="bulk-media-editor-title">{count.toLocaleString("ja-JP")}件を一括編集</h2>
            <p>指定した項目だけを、選択中のメディアへまとめて反映します。</p>
          </div>
          <button type="button" aria-label="閉じる" disabled={busy} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="bulk-media-editor-scroll">
          <section className={initialSection === "details" ? "is-emphasized" : undefined}>
            <div className="bulk-media-section-heading">
              <div>
                <Icon name="info" />
                <span>
                  <strong>年齢区分</strong>
                  <small>変更しない場合は未選択のままにします</small>
                </span>
              </div>
              {ageRating && (
                <button type="button" onClick={() => setAgeRating(undefined)}>変更しない</button>
              )}
            </div>
            <div className="bulk-rating-options">
              {ratingOptions.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={ageRating === option.value ? "is-selected" : ""}
                  aria-pressed={ageRating === option.value}
                  onClick={() => setAgeRating((current) => current === option.value ? undefined : option.value)}
                >
                  <span>{option.label}</span>
                  <small>{option.detail}</small>
                  {ageRating === option.value && <Icon name="check" />}
                </button>
              ))}
            </div>
          </section>

          <section className={initialSection === "tags" ? "is-emphasized" : undefined}>
            <div className="bulk-media-section-heading">
              <div>
                <Icon name="tag" />
                <span>
                  <strong>タグ</strong>
                  <small>追加、または現在のタグを置き換え</small>
                </span>
              </div>
              <label className="bulk-tag-enable">
                <input
                  type="checkbox"
                  checked={applyTags}
                  onChange={(event) => setApplyTags(event.target.checked)}
                />
                <span>タグを反映</span>
              </label>
            </div>

            <div className="bulk-tag-mode" aria-label="タグの反映方法">
              <button
                type="button"
                className={tagMode === "add" ? "is-selected" : ""}
                aria-pressed={tagMode === "add"}
                onClick={() => {
                  setTagMode("add");
                  setApplyTags(true);
                }}
              >
                既存タグへ追加
              </button>
              <button
                type="button"
                className={tagMode === "replace" ? "is-selected" : ""}
                aria-pressed={tagMode === "replace"}
                onClick={() => {
                  setTagMode("replace");
                  setApplyTags(true);
                }}
              >
                選択タグで置換
              </button>
            </div>

            <div className="bulk-tag-create">
              <input
                value={newTag}
                aria-label="新しいタグ名"
                placeholder="新しいタグを作成"
                disabled={creating || busy}
                onChange={(event) => setNewTag(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createTag();
                  }
                }}
              />
              <button
                type="button"
                disabled={creating || busy || !newTag.trim()}
                onClick={() => void createTag()}
              >
                {creating ? "作成中…" : "追加"}
              </button>
            </div>

            <div className="bulk-tag-options" aria-busy={loading}>
              {loading ? (
                <span className="bulk-media-loading"><i />タグを読み込み中…</span>
              ) : availableTags.length === 0 ? (
                <p>タグはまだありません。上の入力欄から作成できます。</p>
              ) : availableTags.map((tag) => {
                const translated = translateTag(tag.name);
                return (
                  <button
                    type="button"
                    key={tag.id}
                    className={selectedIds.has(tag.id) ? "is-selected" : ""}
                    aria-pressed={selectedIds.has(tag.id)}
                    title={translated !== tag.name ? tag.name : undefined}
                    onClick={() => toggleTag(tag.id)}
                  >
                    <i style={{ backgroundColor: tag.color || "#a77bf3" }} />
                    <span>{translated}</span>
                    {selectedIds.has(tag.id) && <Icon name="check" />}
                  </button>
                );
              })}
            </div>
            {applyTags && (
              <p className="bulk-tag-summary">
                {tagMode === "add" ? "追加" : "置換"}対象: {selectedTags.length.toLocaleString("ja-JP")}タグ
                {tagMode === "replace" && selectedTags.length === 0 ? "（タグをすべて解除）" : ""}
              </p>
            )}
          </section>

          {error && <p className="bulk-media-editor-error"><Icon name="warning" />{error}</p>}
        </div>

        <footer>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || loading || (!ageRating && !applyTags)}
            onClick={() => onApply({
              ageRating,
              applyTags,
              tagIds: [...selectedIds],
              tags: selectedTags,
              tagMode,
            })}
          >
            {busy ? <><span className="spinner" />反映中…</> : <><Icon name="check" />選択中の項目へ反映</>}
          </button>
        </footer>
      </section>
    </div>
  );
}
