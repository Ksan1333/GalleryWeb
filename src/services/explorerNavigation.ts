import type { ExternalMediaOpenBatch, MediaItem } from "./native";

export type ExplorerRequest = { requestId: string; path?: string };
export type ExplorerHistory = {
  path?: string;
  back: Array<string | undefined>;
  forward: Array<string | undefined>;
};

let remembered: ExplorerHistory = { back: [], forward: [] };
const MAX_HISTORY = 100;

export function readExplorerHistory(): ExplorerHistory {
  return { ...remembered, back: [...remembered.back], forward: [...remembered.forward] };
}

export function rememberExplorerHistory(history: ExplorerHistory): void {
  remembered = { ...history, back: [...history.back], forward: [...history.forward] };
}

export function navigateExplorer(history: ExplorerHistory, path?: string): ExplorerHistory {
  if (path === history.path) return history;
  return { path, back: [...history.back, history.path].slice(-MAX_HISTORY), forward: [] };
}

export function stepExplorer(history: ExplorerHistory, direction: "back" | "forward"): ExplorerHistory {
  const source = history[direction];
  if (source.length === 0) return history;
  return direction === "back"
    ? { path: source[source.length - 1], back: source.slice(0, -1), forward: [...history.forward, history.path].slice(-MAX_HISTORY) }
    : { path: source[source.length - 1], forward: source.slice(0, -1), back: [...history.back, history.path].slice(-MAX_HISTORY) };
}

/** Native paths only. Preserve a file's drive/share root. */
export function parentFilePath(path: string): string | undefined {
  if (!path || /^(https?:|data:|blob:)/i.test(path)) return undefined;
  const separator = path.includes("\\") ? "\\" : "/";
  const normalized = path.replace(/[\\/]/g, separator).replace(/[\\/]+$/, "");
  const index = normalized.lastIndexOf(separator);
  if (index < 0) return undefined;
  if (index === 0 || /^(?:\\\\\?\\)?[a-z]:$/i.test(normalized.slice(0, index))) return normalized.slice(0, index + 1);
  return normalized.slice(0, index);
}

export function externalExplorerTarget(batch: ExternalMediaOpenBatch): {
  request: ExplorerRequest;
  item: MediaItem;
} | undefined {
  const item = batch.items.find((value) => value.id === batch.currentId) ?? batch.items[0];
  const path = item && parentFilePath(item.path);
  return item && path ? { request: { requestId: batch.requestId, path }, item } : undefined;
}

export function joinFolderPath(root: string, relative: string): string {
  if (!relative) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + separator + relative.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "");
}

export function sameExplorerPath(left?: string, right?: string): boolean {
  const normalize = (value?: string) => {
    if (!value) return "";
    const windows = /^(?:[a-z]:|\\\\)/i.test(value);
    const plain = value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
      .replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? plain.toLocaleLowerCase("en-US") : plain;
  };
  return normalize(left) === normalize(right);
}
