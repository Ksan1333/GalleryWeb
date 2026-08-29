export type OperationStatus = "running" | "success" | "error" | "cancelled";

export type OperationItem = {
  id: string;
  label: string;
  detail?: string;
  previewPath?: string;
  progress: number | null;
  status: OperationStatus;
  startedAt: number;
  updatedAt: number;
};

export type StartOperationInput = {
  id?: string;
  label: string;
  detail?: string;
  previewPath?: string;
  progress?: number | null;
};

export type OperationUpdate = {
  label?: string;
  detail?: string;
  previewPath?: string;
  progress?: number | null;
};

export type OperationReport = OperationUpdate & {
  id: string;
  label: string;
  status?: OperationStatus;
  retainForMs?: number;
};

export type OperationHandle = {
  id: string;
  update: (update: OperationUpdate) => void;
  succeed: (detail?: string, retainForMs?: number) => void;
  fail: (error: unknown, retainForMs?: number) => void;
  cancel: (detail?: string, retainForMs?: number) => void;
  dismiss: () => void;
};

type Listener = () => void;

const SUCCESS_RETENTION_MS = 4_500;
const ERROR_RETENTION_MS = 8_000;
const CANCELLED_RETENTION_MS = 3_500;

let operationSequence = 0;

function createOperationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `operation:${randomId}`;
  operationSequence += 1;
  return `operation:${Date.now()}:${operationSequence}`;
}

function normalizeProgress(progress: number | null | undefined): number | null {
  if (progress === null || progress === undefined || !Number.isFinite(progress)) {
    return null;
  }
  return Math.max(0, Math.min(100, progress));
}

export function operationErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "処理中に予期しないエラーが発生しました";
}

class OperationStore {
  private readonly items = new Map<string, OperationItem>();
  private readonly listeners = new Set<Listener>();
  private readonly removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshot: readonly OperationItem[] = [];

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): readonly OperationItem[] => this.snapshot;

  get(id: string): OperationItem | undefined {
    return this.items.get(id);
  }

  start(input: StartOperationInput): OperationHandle {
    const id = input.id ?? createOperationId();
    this.clearRemovalTimer(id);
    const now = Date.now();
    this.items.set(id, {
      id,
      label: input.label,
      detail: input.detail,
      previewPath: input.previewPath,
      progress: normalizeProgress(input.progress),
      status: "running",
      startedAt: now,
      updatedAt: now,
    });
    this.publish();
    return this.handle(id);
  }

  update(id: string, update: OperationUpdate): void {
    const current = this.items.get(id);
    if (!current) return;
    const next: OperationItem = {
      ...current,
      label: update.label ?? current.label,
      updatedAt: Date.now(),
    };
    if ("detail" in update) next.detail = update.detail;
    if ("previewPath" in update) next.previewPath = update.previewPath;
    if ("progress" in update) next.progress = normalizeProgress(update.progress);
    this.items.set(id, next);
    this.publish();
  }

  succeed(id: string, detail?: string, retainForMs = SUCCESS_RETENTION_MS): void {
    this.settle(id, "success", detail, retainForMs);
  }

  fail(id: string, error: unknown, retainForMs = ERROR_RETENTION_MS): void {
    this.settle(id, "error", operationErrorMessage(error), retainForMs);
  }

  cancel(id: string, detail?: string, retainForMs = CANCELLED_RETENTION_MS): void {
    this.settle(id, "cancelled", detail ?? "キャンセルしました", retainForMs);
  }

  dismiss(id: string): void {
    this.clearRemovalTimer(id);
    if (this.items.delete(id)) this.publish();
  }

  report(report: OperationReport): void {
    const status = report.status ?? "running";
    const current = this.items.get(report.id);
    if (!current || (current.status !== "running" && status === "running")) {
      this.start({
        id: report.id,
        label: report.label,
        detail: report.detail,
        previewPath: report.previewPath,
        progress: report.progress,
      });
    } else {
      this.update(report.id, {
        label: report.label,
        detail: report.detail,
        previewPath: report.previewPath,
        progress: report.progress,
      });
    }

    if (status === "success") {
      this.succeed(report.id, report.detail, report.retainForMs);
    } else if (status === "error") {
      this.settle(
        report.id,
        "error",
        report.detail ?? "処理に失敗しました",
        report.retainForMs ?? ERROR_RETENTION_MS,
      );
    } else if (status === "cancelled") {
      this.cancel(report.id, report.detail, report.retainForMs);
    }
  }

  private handle(id: string): OperationHandle {
    return {
      id,
      update: (update) => this.update(id, update),
      succeed: (detail, retainForMs) => this.succeed(id, detail, retainForMs),
      fail: (error, retainForMs) => this.fail(id, error, retainForMs),
      cancel: (detail, retainForMs) => this.cancel(id, detail, retainForMs),
      dismiss: () => this.dismiss(id),
    };
  }

  private settle(
    id: string,
    status: Exclude<OperationStatus, "running">,
    detail: string | undefined,
    retainForMs: number,
  ): void {
    const current = this.items.get(id);
    if (!current) return;
    const updatedAt = Date.now();
    this.items.set(id, {
      ...current,
      detail: detail ?? current.detail,
      progress: status === "success" ? 100 : current.progress,
      status,
      updatedAt,
    });
    this.publish();
    this.clearRemovalTimer(id);
    if (retainForMs <= 0) {
      this.dismiss(id);
      return;
    }
    this.removalTimers.set(
      id,
      setTimeout(() => {
        const latest = this.items.get(id);
        if (latest?.status === status && latest.updatedAt === updatedAt) {
          this.dismiss(id);
        }
      }, retainForMs),
    );
  }

  private clearRemovalTimer(id: string): void {
    const timer = this.removalTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.removalTimers.delete(id);
  }

  private publish(): void {
    this.snapshot = [...this.items.values()].sort(
      (left, right) => left.startedAt - right.startedAt,
    );
    for (const listener of this.listeners) listener();
  }
}

export const operationStore = new OperationStore();

export function startOperation(input: StartOperationInput): OperationHandle {
  return operationStore.start(input);
}

export function reportOperation(report: OperationReport): void {
  operationStore.report(report);
}

export function updateOperation(id: string, update: OperationUpdate): void {
  operationStore.update(id, update);
}

export function succeedOperation(
  id: string,
  detail?: string,
  retainForMs?: number,
): void {
  operationStore.succeed(id, detail, retainForMs);
}

export function failOperation(
  id: string,
  error: unknown,
  retainForMs?: number,
): void {
  operationStore.fail(id, error, retainForMs);
}

export function cancelOperation(
  id: string,
  detail?: string,
  retainForMs?: number,
): void {
  operationStore.cancel(id, detail, retainForMs);
}

export function dismissOperation(id: string): void {
  operationStore.dismiss(id);
}
