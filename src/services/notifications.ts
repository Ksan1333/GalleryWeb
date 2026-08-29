import { showWindowsNotification } from "./native";

export type AppNotificationTone = "success" | "info" | "error";

export type AppNotification = {
  id: string;
  title: string;
  message: string;
  tone: AppNotificationTone;
  createdAt: number;
  read: boolean;
};

type NotificationInput = Pick<AppNotification, "title" | "message"> & {
  tone?: AppNotificationTone;
};

type Listener = () => void;

const STORAGE_KEY = "pixvault-app-notifications";
const MAX_NOTIFICATIONS = 50;
let nativeNotificationsEnabled = true;

export function configureNativeNotifications(enabled: boolean): void {
  nativeNotificationsEnabled = enabled;
}

function readStoredNotifications(): AppNotification[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is AppNotification => Boolean(
        item
        && typeof item === "object"
        && typeof (item as AppNotification).id === "string"
        && typeof (item as AppNotification).title === "string"
        && typeof (item as AppNotification).message === "string"
        && typeof (item as AppNotification).createdAt === "number",
      ))
      .slice(0, MAX_NOTIFICATIONS);
  } catch {
    return [];
  }
}

class NotificationStore {
  private items: readonly AppNotification[] = readStoredNotifications();
  private readonly listeners = new Set<Listener>();

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly AppNotification[] => this.items;

  notify(input: NotificationInput): AppNotification {
    const notification: AppNotification = {
      id: globalThis.crypto?.randomUUID?.() ?? `notification:${Date.now()}:${Math.random()}`,
      title: input.title,
      message: input.message,
      tone: input.tone ?? "info",
      createdAt: Date.now(),
      read: false,
    };
    this.items = [notification, ...this.items].slice(0, MAX_NOTIFICATIONS);
    this.publish();
    if (nativeNotificationsEnabled) {
      void showWindowsNotification(
        notification.title,
        notification.message,
        notification.tone,
      );
    }
    return notification;
  }

  markAllRead(): void {
    if (!this.items.some((item) => !item.read)) return;
    this.items = this.items.map((item) => ({ ...item, read: true }));
    this.publish();
  }

  dismiss(id: string): void {
    const next = this.items.filter((item) => item.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.publish();
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.publish();
  }

  private publish(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
    } catch {
      // Notifications remain available for the current app session.
    }
    for (const listener of this.listeners) listener();
  }
}

export const notificationStore = new NotificationStore();

export function notifyApp(input: NotificationInput): AppNotification {
  return notificationStore.notify(input);
}
