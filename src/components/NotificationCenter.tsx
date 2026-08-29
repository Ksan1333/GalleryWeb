import { useEffect, useRef, useState } from "react";

import { useNotifications } from "../hooks/useNotifications";
import { notificationStore, type AppNotification } from "../services/notifications";
import { Icon } from "./Icon";
import "./NotificationCenter.css";

function notificationTime(createdAt: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(createdAt));
}

export function NotificationCenter() {
  const notifications = useNotifications();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<AppNotification>();
  const hostRef = useRef<HTMLDivElement>(null);
  const lastToastId = useRef(notifications[0]?.id);
  const unreadCount = notifications.filter((item) => !item.read).length;

  useEffect(() => {
    const latest = notifications[0];
    if (!latest || latest.id === lastToastId.current) return;
    lastToastId.current = latest.id;
    setToast(latest);
    const timer = window.setTimeout(() => setToast((current) => (
      current?.id === latest.id ? undefined : current
    )), 6_000);
    return () => window.clearTimeout(timer);
  }, [notifications]);

  useEffect(() => {
    if (!open) return;
    notificationStore.markAllRead();
    const close = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <>
      <div className="notification-center" ref={hostRef}>
        <button
          className="icon-button notification-button"
          type="button"
          aria-label={`通知${unreadCount > 0 ? `、未読${unreadCount}件` : ""}`}
          aria-expanded={open}
          title="通知"
          onClick={() => setOpen((current) => !current)}
        >
          <Icon name="bell" />
          {unreadCount > 0 && <span>{unreadCount > 9 ? "9+" : unreadCount}</span>}
        </button>
        {open && (
          <aside className="notification-panel" aria-label="通知一覧">
            <header>
              <div><small>NOTIFICATIONS</small><strong>通知</strong></div>
              {notifications.length > 0 && (
                <button type="button" onClick={() => notificationStore.clear()}>すべて消去</button>
              )}
            </header>
            <div className="notification-list">
              {notifications.length === 0 ? (
                <div className="notification-empty"><Icon name="bell" /><span>通知はありません</span></div>
              ) : notifications.map((item) => (
                <article className={`is-${item.tone}`} key={item.id}>
                  <span><Icon name={item.tone === "success" ? "check" : item.tone === "error" ? "warning" : "info"} /></span>
                  <div><strong>{item.title}</strong><p>{item.message}</p><small>{notificationTime(item.createdAt)}</small></div>
                  <button type="button" aria-label={`${item.title}を削除`} onClick={() => notificationStore.dismiss(item.id)}><Icon name="close" /></button>
                </article>
              ))}
            </div>
          </aside>
        )}
      </div>
      {toast && (
        <aside className={`app-notification-toast is-${toast.tone}`} role="status" aria-live="polite">
          <span><Icon name={toast.tone === "success" ? "check" : toast.tone === "error" ? "warning" : "info"} /></span>
          <div><strong>{toast.title}</strong><p>{toast.message}</p></div>
          <button type="button" aria-label="通知を閉じる" onClick={() => setToast(undefined)}><Icon name="close" /></button>
        </aside>
      )}
    </>
  );
}

export default NotificationCenter;

