import { useEffect, useRef, useState } from "react";
import { useAppBack } from "../hooks/useAppBack";
import { getMediaItemsByIds, revealMediaInExplorer, type MediaItem } from "../services/native";
import { Icon } from "./Icon";
import { MediaInfoSidebar } from "./MediaViewer";
import "./MediaPropertiesDialog.css";

const noAction = () => {};
const noItems: MediaItem[] = [];

export function MediaPropertiesDialog({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const [details, setDetails] = useState(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useAppBack(true, onClose);

  useEffect(() => {
    let active = true;
    setDetails(item);
    void getMediaItemsByIds([item.id]).then((result) => {
      if (!active) return;
      if (result.data[0]) setDetails(result.data[0]);
      setError(result.error);
    });
    return () => { active = false; };
  }, [item]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab" && dialog) {
        const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input, [tabindex='0']")]
          .filter((element) => element.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const reveal = async () => {
    setBusy(true);
    const result = await revealMediaInExplorer(details.id);
    setError(result.error);
    setBusy(false);
  };

  return (
    <div className="media-properties-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="media-properties-dialog" role="dialog" aria-modal="true" aria-labelledby="media-properties-title">
        <header>
          <h2 id="media-properties-title"><Icon name="info" />プロパティ</h2>
          <button type="button" onClick={onClose} aria-label="プロパティを閉じる"><Icon name="close" /></button>
        </header>
        <div className="media-properties-body">
          {error && <p className="media-properties-error" role="alert">{error}</p>}
          <MediaInfoSidebar
            propertiesOnly
            item={details}
            items={noItems}
            tags={details.tags}
            ageRating={details.ageRating}
            favorite={details.isFavorite}
            runtimeMetadata={{}}
            pageCount={details.pageCount ?? 0}
            pageIndex={0}
            layout="right"
            open
            busy={busy}
            onToggleOpen={noAction}
            onLayoutChange={noAction}
            onSelect={noAction}
            onReveal={() => void reveal()}
          />
        </div>
      </section>
    </div>
  );
}
