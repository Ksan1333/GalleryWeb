import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type SelectMenuOption = {
  value: string;
  label: string;
  description?: string;
};

export function SelectMenu({
  value,
  options,
  onChange,
  label,
  ariaLabel,
  disabled = false,
  className = "",
}: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [opensUp, setOpensUp] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState(320);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const updateMenuPlacement = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      let topBoundary = 8;
      let bottomBoundary = window.innerHeight - 8;
      let ancestor = trigger.parentElement;
      while (ancestor && ancestor !== document.body) {
        const style = window.getComputedStyle(ancestor);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          const rect = ancestor.getBoundingClientRect();
          topBoundary = Math.max(topBoundary, rect.top + 8);
          bottomBoundary = Math.min(bottomBoundary, rect.bottom - 8);
        }
        ancestor = ancestor.parentElement;
      }
      const above = Math.max(0, triggerRect.top - topBoundary - 8);
      const below = Math.max(0, bottomBoundary - triggerRect.bottom - 8);
      const nextOpensUp = below < Math.min(260, above) && above > below;
      setOpensUp(nextOpensUp);
      setMenuMaxHeight(Math.max(120, Math.min(320, nextOpensUp ? above : below)));
    };
    updateMenuPlacement();
    window.addEventListener("resize", updateMenuPlacement);
    document.addEventListener("scroll", updateMenuPlacement, true);
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    setActiveIndex(selectedIndex);
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.setTimeout(() => {
      rootRef.current
        ?.querySelectorAll<HTMLButtonElement>('[role="option"]')
        .item(selectedIndex)
        ?.focus();
    });
    return () => {
      window.removeEventListener("resize", updateMenuPlacement);
      document.removeEventListener("scroll", updateMenuPlacement, true);
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, options.length, value]);

  function choose(nextValue: string) {
    onChange(nextValue);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function focusOption(nextIndex: number) {
    if (options.length === 0) return;
    const normalizedIndex = (nextIndex + options.length) % options.length;
    setActiveIndex(normalizedIndex);
    window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelectorAll<HTMLButtonElement>('[role="option"]')
        .item(normalizedIndex)
        ?.focus();
    });
  }

  return (
    <div
      className={`pv-select ${open ? "is-open" : ""} ${className}`.trim()}
      data-placement={opensUp ? "up" : "down"}
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      {label && <span className="pv-select-label">{label}</span>}
      <button
        ref={triggerRef}
        className="pv-select-trigger"
        type="button"
        role="combobox"
        aria-label={ariaLabel ?? label}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? "選択してください"}</span>
        <Icon name="chevronDown" />
      </button>
      {open && (
        <div
          className="pv-select-menu"
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel ?? label}
          style={{ maxHeight: menuMaxHeight }}
        >
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "is-selected" : ""}
              tabIndex={index === activeIndex ? 0 : -1}
              key={option.value}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  focusOption(index + (event.key === "ArrowDown" ? 1 : -1));
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  focusOption(event.key === "Home" ? 0 : options.length - 1);
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(option.value);
                }
              }}
              onClick={() => choose(option.value)}
            >
              <span>
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
              {option.value === value && <Icon name="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  titleContent,
  description,
  actions,
  onTitleClick,
}: {
  eyebrow: string;
  title: string;
  titleContent?: ReactNode;
  description: string;
  actions?: ReactNode;
  onTitleClick?: () => void;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="kicker">{eyebrow}</p>
        <h1>
          {titleContent ?? (onTitleClick ? (
            <button
              className="page-title-link"
              type="button"
              onClick={onTitleClick}
              title={`${title}へ戻る`}
            >
              {title}
              <Icon name="chevronRight" />
            </button>
          ) : title)}
        </h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function StatusPanel({
  tone = "neutral",
  icon = "info",
  title,
  children,
  action,
}: {
  tone?: "neutral" | "info" | "warning" | "error" | "success";
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={`status-panel ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className="status-icon"><Icon name={icon} /></div>
      <div className="status-copy">
        <strong>{title}</strong>
        {children && <div>{children}</div>}
      </div>
      {action && <div className="status-action">{action}</div>}
    </section>
  );
}

export function LoadingPanel({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="loading-panel" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} /></div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function NativePreviewNotice() {
  return (
    <StatusPanel tone="info" icon="info" title="ブラウザプレビューを表示しています">
      <p>
        ローカルフォルダーやSQLiteには接続していません。実データを扱うにはWindowsアプリ版を起動してください。
      </p>
    </StatusPanel>
  );
}

const JA_COUNT_FORMATTER = new Intl.NumberFormat("ja-JP");
const JA_BYTES_INTEGER_FORMATTER = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 0,
});
const JA_BYTES_DECIMAL_FORMATTER = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 1,
});
const JA_MEDIUM_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatCount(value: number): string {
  return JA_COUNT_FORMATTER.format(value);
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** unit;
  const formatter = size >= 10 || unit === 0
    ? JA_BYTES_INTEGER_FORMATTER
    : JA_BYTES_DECIMAL_FORMATTER;
  return `${formatter.format(size)} ${units[unit]}`;
}

export function formatDate(value?: string): string {
  if (!value) return "未実行";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return JA_MEDIUM_DATE_TIME_FORMATTER.format(date);
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds < 0) return "";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
