import { useSyncExternalStore } from "react";

import { operationStore, type OperationItem } from "../services/operations";

export function useOperations(): readonly OperationItem[] {
  return useSyncExternalStore(
    operationStore.subscribe,
    operationStore.getSnapshot,
    operationStore.getSnapshot,
  );
}

export function useOperation(id: string | undefined): OperationItem | undefined {
  const operations = useOperations();
  return id ? operations.find((operation) => operation.id === id) : undefined;
}

