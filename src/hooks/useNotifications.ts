import { useSyncExternalStore } from "react";

import { notificationStore } from "../services/notifications";

export function useNotifications() {
  return useSyncExternalStore(
    notificationStore.subscribe,
    notificationStore.getSnapshot,
    notificationStore.getSnapshot,
  );
}

