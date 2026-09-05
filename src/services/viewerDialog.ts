const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]';

/** Isolate only siblings on the dialog's ancestor path; nested dialogs stay usable. */
export function activateViewerDialog(dialog: HTMLElement): () => void {
  const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const previousOverflow = document.body.style.overflow;
  const isolated: Array<[HTMLElement, boolean]> = [];
  for (let branch: HTMLElement | null = dialog; branch?.parentElement; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      isolated.push([sibling, sibling.inert]);
      sibling.inert = true;
    }
    if (branch.parentElement === document.body) break;
  }
  const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => (
    element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert], [hidden]') && element.getClientRects().length > 0
  ));
  const focusDialog = () => { dialog.focus({ preventScroll: true }); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const elements = focusable();
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) {
      event.preventDefault();
      focusDialog();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (event.target instanceof Node && !dialog.contains(event.target)) focusDialog();
  };
  document.body.style.overflow = "hidden";
  dialog.setAttribute("tabindex", "-1");
  focusDialog();
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("focusin", onFocusIn);
    isolated.forEach(([element, inert]) => { element.inert = inert; });
    document.body.style.overflow = previousOverflow;
    if (origin?.isConnected && !origin.closest('[inert]')) origin.focus({ preventScroll: true });
  };
}
