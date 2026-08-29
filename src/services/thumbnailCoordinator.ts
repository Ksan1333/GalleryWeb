import {
  useCallback,
  useEffect,
  useSyncExternalStore,
} from "react";
import { listen } from "@tauri-apps/api/event";

import {
  getMediaThumbnail,
  getMediaThumbnails,
  isTauriRuntime,
  mediaThumbnailResolvedEvent,
  type MediaThumbnailLookup,
  type NativeResult,
} from "./native";

export type ThumbnailPriority = "visible" | "nearby" | "background";

export type ThumbnailSnapshot = {
  path?: string;
  pending: boolean;
  status: "idle" | "queued" | "loading" | "ready" | "missing" | "error";
};

export type ThumbnailPrefetchTarget = {
  mediaId: string;
  revision?: string;
  knownPath?: string;
  priority: ThumbnailPriority;
};

type ThumbnailEntry = {
  key: string;
  mediaId: string;
  revision?: string;
  snapshot: ThumbnailSnapshot;
  listeners: Set<() => void>;
  leases: Map<symbol, ThumbnailPriority>;
  priority: number;
  sequence: number;
  generation: number;
  settledAt: number;
  touchedAt: number;
};

type LookupRequest = {
  entry: ThumbnailEntry;
  generation: number;
};

const PRIORITY_VALUE: Record<ThumbnailPriority, number> = {
  visible: 0,
  nearby: 1,
  background: 2,
};
const MAX_COORDINATOR_ENTRIES = 4_096;
const FAILED_LOOKUP_RETRY_MS = 3_000;
// Keep only a small amount of uncancellable native work in flight. In
// particular, a batch containing slow/unsupported videos must not leave a
// newly visible scroll range waiting behind dozens of stale requests.
const LOOKUP_BATCH_SIZE = 8;
const MAX_CONCURRENT_BATCHES = 2;
const entries = new Map<string, ThumbnailEntry>();
const entriesByMediaId = new Map<string, Set<ThumbnailEntry>>();
const queuedEntries = new Map<string, ThumbnailEntry>();
let activeBatches = 0;
let requestSequence = 0;
let lookupPumpScheduled = false;

function thumbnailKey(mediaId: string, revision?: string): string {
  return `${mediaId}\u0000${revision ?? ""}`;
}

function entryFor(mediaId: string, revision?: string): ThumbnailEntry {
  const key = thumbnailKey(mediaId, revision);
  const existing = entries.get(key);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const entry: ThumbnailEntry = {
    key,
    mediaId,
    revision,
    snapshot: { pending: true, status: "idle" },
    listeners: new Set(),
    leases: new Map(),
    priority: PRIORITY_VALUE.background,
    sequence: 0,
    generation: 0,
    settledAt: 0,
    touchedAt: Date.now(),
  };
  entries.set(key, entry);
  const mediaEntries = entriesByMediaId.get(mediaId) ?? new Set<ThumbnailEntry>();
  mediaEntries.add(entry);
  entriesByMediaId.set(mediaId, mediaEntries);
  return entry;
}

function deleteEntry(entry: ThumbnailEntry) {
  entries.delete(entry.key);
  queuedEntries.delete(entry.key);
  const mediaEntries = entriesByMediaId.get(entry.mediaId);
  mediaEntries?.delete(entry);
  if (mediaEntries?.size === 0) entriesByMediaId.delete(entry.mediaId);
}

function effectivePriority(entry: ThumbnailEntry): number {
  let priority = PRIORITY_VALUE.background;
  entry.leases.forEach((value) => {
    priority = Math.min(priority, PRIORITY_VALUE[value]);
  });
  return priority;
}

function publish(entry: ThumbnailEntry, snapshot: ThumbnailSnapshot) {
  if (
    entry.snapshot.path === snapshot.path
    && entry.snapshot.pending === snapshot.pending
    && entry.snapshot.status === snapshot.status
  ) return;
  const previous = entry.snapshot;
  if (previous.status === "queued") queuedEntries.delete(entry.key);
  entry.snapshot = snapshot;
  if (snapshot.status === "queued") queuedEntries.set(entry.key, entry);
  entry.touchedAt = Date.now();
  entry.listeners.forEach((listener) => listener());
}

function pruneEntries() {
  if (entries.size <= MAX_COORDINATOR_ENTRIES) return;
  const removable = [...entries.values()]
    .filter((entry) =>
      entry.leases.size === 0
      && entry.snapshot.status !== "loading"
      && entry.snapshot.status !== "queued",
    )
    .sort((left, right) => left.touchedAt - right.touchedAt);
  while (entries.size > MAX_COORDINATOR_ENTRIES && removable.length > 0) {
    const entry = removable.shift();
    if (entry) deleteEntry(entry);
  }
}

function nextQueuedEntry(): ThumbnailEntry | undefined {
  let candidate: ThumbnailEntry | undefined;
  queuedEntries.forEach((entry) => {
    if (entry.leases.size === 0) return;
    if (
      !candidate
      || entry.priority < candidate.priority
      || (entry.priority === candidate.priority && entry.sequence < candidate.sequence)
    ) candidate = entry;
  });
  return candidate;
}

async function lookupOneByOne(requests: readonly LookupRequest[]) {
  let cursor = 0;
  const results = new Map<string, NativeResult<string | null>>();
  const worker = async () => {
    while (cursor < requests.length) {
      const request = requests[cursor];
      cursor += 1;
      if (!request) return;
      try {
        results.set(request.entry.mediaId, await getMediaThumbnail(request.entry.mediaId));
      } catch {
        results.set(request.entry.mediaId, {
          data: null,
          available: isTauriRuntime(),
          error: "thumbnail lookup failed",
        });
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(2, requests.length) },
    () => worker(),
  ));
  return results;
}

async function resolveLookupBatch(requests: readonly LookupRequest[]) {
  let rows: Map<string, MediaThumbnailLookup> | undefined;
  let fallback: Map<string, NativeResult<string | null>> | undefined;
  try {
    const batch = await getMediaThumbnails(requests.map(({ entry }) => entry.mediaId));
    if (!batch.error && batch.available) {
      rows = new Map(batch.data.map((row) => [row.mediaId, row]));
    } else {
      // Browser preview and an older installed binary do not expose the batch
      // command. Keep that compatibility path deliberately low-concurrency.
      fallback = await lookupOneByOne(requests);
    }
  } catch {
    fallback = await lookupOneByOne(requests);
  }

  requests.forEach(({ entry, generation }) => {
    // A native completion event may already have published this exact item.
    if (entry.generation !== generation) return;
    const row = rows?.get(entry.mediaId);
    const single = fallback?.get(entry.mediaId);
    const path = row?.thumbnailPath ?? single?.data ?? undefined;
    entry.settledAt = Date.now();
    if (path) {
      publish(entry, { path, pending: false, status: "ready" });
    } else if (single?.error) {
      publish(entry, { pending: false, status: "error" });
    } else {
      publish(entry, { pending: false, status: "missing" });
    }
  });
}

function pumpLookupQueue() {
  lookupPumpScheduled = false;
  while (activeBatches < MAX_CONCURRENT_BATCHES) {
    const requests: LookupRequest[] = [];
    while (requests.length < LOOKUP_BATCH_SIZE) {
      const entry = nextQueuedEntry();
      if (!entry) break;
      const generation = entry.generation;
      publish(entry, { pending: true, status: "loading" });
      requests.push({ entry, generation });
    }
    if (requests.length === 0) return;
    activeBatches += 1;
    void resolveLookupBatch(requests).finally(() => {
      activeBatches = Math.max(0, activeBatches - 1);
      pruneEntries();
      scheduleLookupPump();
    });
  }
}

function scheduleLookupPump() {
  if (lookupPumpScheduled) return;
  lookupPumpScheduled = true;
  // Coalesce sibling card effects into one native call.
  queueMicrotask(pumpLookupQueue);
}

function queueEntry(entry: ThumbnailEntry, deferPump = false) {
  if (
    (entry.snapshot.status === "missing" || entry.snapshot.status === "error")
    && Date.now() - entry.settledAt >= FAILED_LOOKUP_RETRY_MS
  ) publish(entry, { pending: true, status: "idle" });
  if (
    entry.snapshot.status === "ready"
    || entry.snapshot.status === "loading"
    || entry.snapshot.status === "queued"
    || entry.snapshot.status === "missing"
    || entry.snapshot.status === "error"
  ) {
    if (entry.snapshot.status === "queued") entry.priority = effectivePriority(entry);
    if (!deferPump) scheduleLookupPump();
    return;
  }
  entry.priority = effectivePriority(entry);
  entry.sequence = requestSequence++;
  publish(entry, { pending: true, status: "queued" });
  if (!deferPump) scheduleLookupPump();
}

function retainEntry(
  target: ThumbnailPrefetchTarget,
  deferPump = false,
): () => void {
  const entry = entryFor(target.mediaId, target.revision);
  if (target.knownPath) {
    seedCoordinatedThumbnail(target.mediaId, target.revision, target.knownPath);
  }
  const lease = Symbol(target.priority);
  entry.leases.set(lease, target.priority);
  entry.priority = effectivePriority(entry);
  if (!target.knownPath) queueEntry(entry, deferPump);
  return () => {
    entry.leases.delete(lease);
    entry.priority = effectivePriority(entry);
    if (entry.leases.size === 0 && entry.snapshot.status === "queued") {
      // Existing native calls cannot be aborted, but work that has not crossed
      // the IPC boundary is discarded as soon as it leaves the virtual range.
      entry.generation += 1;
      publish(entry, { pending: true, status: "idle" });
    }
  };
}

export function prefetchThumbnails(
  targets: readonly ThumbnailPrefetchTarget[],
): () => void {
  const strongestTargets = new Map<string, ThumbnailPrefetchTarget>();
  targets.forEach((target) => {
    if (!target.mediaId) return;
    const key = thumbnailKey(target.mediaId, target.revision);
    const current = strongestTargets.get(key);
    if (!current || PRIORITY_VALUE[target.priority] < PRIORITY_VALUE[current.priority]) {
      strongestTargets.set(key, target);
    }
  });
  const orderedTargets = [...strongestTargets.values()].sort(
    (left, right) => PRIORITY_VALUE[left.priority] - PRIORITY_VALUE[right.priority],
  );
  const releases = orderedTargets.map((target) => retainEntry(target, true));
  scheduleLookupPump();
  return () => releases.forEach((release) => release());
}

export function seedCoordinatedThumbnail(
  mediaId: string,
  revision: string | undefined,
  path: string,
) {
  if (!mediaId || !path) return;
  const entry = entryFor(mediaId, revision);
  entry.generation += 1;
  entry.settledAt = Date.now();
  publish(entry, { path, pending: false, status: "ready" });
  pruneEntries();
}

function seedExistingEntries(mediaId: string, path: string) {
  entriesByMediaId.get(mediaId)?.forEach((entry) => {
    if (entry.snapshot.status === "ready" && entry.snapshot.path === path) return;
    entry.generation += 1;
    entry.settledAt = Date.now();
    publish(entry, { path, pending: false, status: "ready" });
  });
}

if (typeof window !== "undefined") {
  window.addEventListener(mediaThumbnailResolvedEvent, (event) => {
    const detail = (event as CustomEvent<{ mediaId?: string; path?: string }>).detail;
    if (detail?.mediaId && detail.path) seedExistingEntries(detail.mediaId, detail.path);
  });
  if (isTauriRuntime()) {
    // Rust emits each row as soon as it is resolved, so cards repaint without
    // waiting for the rest of their batch to finish.
    void listen<{ mediaId?: string; thumbnailPath?: string }>(
        "media-thumbnail-resolved",
        ({ payload }) => {
          if (payload?.mediaId && payload.thumbnailPath) {
            seedExistingEntries(payload.mediaId, payload.thumbnailPath);
          }
        },
      )
      .catch(() => undefined);
  }
}

export function useCoordinatedThumbnail(
  mediaId: string,
  revision: string | undefined,
  knownPath: string | undefined,
  priority: ThumbnailPriority = "visible",
): ThumbnailSnapshot {
  const key = thumbnailKey(mediaId, revision);
  const subscribe = useCallback((listener: () => void) => {
    const entry = entryFor(mediaId, revision);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }, [key, mediaId, revision]);
  const getSnapshot = useCallback(
    () => entryFor(mediaId, revision).snapshot,
    [key, mediaId, revision],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => retainEntry({ mediaId, revision, knownPath, priority }), [
    knownPath,
    mediaId,
    priority,
    revision,
  ]);

  if (knownPath) return { path: knownPath, pending: false, status: "ready" };
  return snapshot;
}
