import { getJsonPreference, setJsonPreference } from "./native";

export type FolderNavigationKey = "all" | "images" | "videos" | "books";

export type FolderNavigationState = {
  location?: { rootId: string; path: string };
  search?: string;
};

const folderNavigationMemory = new Map<FolderNavigationKey, FolderNavigationState>();

export function rememberFolderNavigation(
  navigationKey: FolderNavigationKey,
  location: { rootId: string; path: string } | undefined,
) {
  folderNavigationMemory.set(navigationKey, { location });
}

export function readFolderNavigation(
  navigationKey: FolderNavigationKey,
): FolderNavigationState | undefined {
  return folderNavigationMemory.get(navigationKey);
}

export type FolderActivityRecord = {
  key: string;
  rootId: string;
  relativePath: string;
  displayName: string;
  rootName: string;
  itemCount: number;
  navigationKey: FolderNavigationKey;
  visits: number;
  lastVisitedAt?: string;
  isFavorite: boolean;
};

export type FolderActivityInput = Pick<
  FolderActivityRecord,
  "rootId" | "relativePath" | "displayName" | "rootName" | "itemCount" | "navigationKey"
>;

const PREFERENCE_KEY = "folderActivity";
const MAX_RECORDS = 300;
export const folderActivityChangedEvent = "pixvault:folder-activity-changed";

let cachedRecords: FolderActivityRecord[] | undefined;
let loadPromise: Promise<FolderActivityRecord[]> | undefined;
let mutationQueue: Promise<unknown> = Promise.resolve();

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function folderActivityKey(rootId: string, relativePath: string): string {
  return `${rootId}\u0000${normalizedPath(relativePath)}`;
}

function normalizeRecord(value: FolderActivityRecord): FolderActivityRecord | undefined {
  if (!value || typeof value.rootId !== "string" || !value.rootId) return undefined;
  const relativePath = normalizedPath(String(value.relativePath ?? ""));
  const navigationKey: FolderNavigationKey = value.navigationKey === "all"
    ? "all"
    : value.navigationKey === "videos"
      ? "videos"
      : value.navigationKey === "books"
        ? "books"
        : "images";
  return {
    key: folderActivityKey(value.rootId, relativePath),
    rootId: value.rootId,
    relativePath,
    displayName: String(value.displayName || value.rootName || "フォルダー"),
    rootName: String(value.rootName || value.displayName || "登録フォルダー"),
    itemCount: Math.max(0, Number(value.itemCount) || 0),
    navigationKey,
    visits: Math.max(0, Math.floor(Number(value.visits) || 0)),
    lastVisitedAt: typeof value.lastVisitedAt === "string" ? value.lastVisitedAt : undefined,
    isFavorite: Boolean(value.isFavorite),
  };
}

function sortAndLimit(records: FolderActivityRecord[]): FolderActivityRecord[] {
  return [...records]
    .sort((left, right) => {
      if (left.isFavorite !== right.isFavorite) return left.isFavorite ? -1 : 1;
      return (right.lastVisitedAt ?? "").localeCompare(left.lastVisitedAt ?? "");
    })
    .slice(0, MAX_RECORDS);
}

function publish(records: FolderActivityRecord[]) {
  window.dispatchEvent(new CustomEvent(folderActivityChangedEvent, { detail: records }));
}

export async function loadFolderActivity(): Promise<FolderActivityRecord[]> {
  if (cachedRecords) return cachedRecords;
  if (loadPromise) return loadPromise;
  loadPromise = getJsonPreference<FolderActivityRecord[]>(PREFERENCE_KEY, [])
    .then((result) => {
      const source = Array.isArray(result.data) ? result.data : [];
      cachedRecords = sortAndLimit(
        source.flatMap((record) => {
          const normalized = normalizeRecord(record);
          return normalized ? [normalized] : [];
        }),
      );
      return cachedRecords;
    })
    .finally(() => { loadPromise = undefined; });
  return loadPromise;
}

async function mutate(
  update: (records: FolderActivityRecord[]) => FolderActivityRecord[],
): Promise<FolderActivityRecord[]> {
  const task = mutationQueue.then(async () => {
    const previous = await loadFolderActivity();
    const next = sortAndLimit(update(previous));
    const result = await setJsonPreference(PREFERENCE_KEY, next);
    if (!result.data || result.error) {
      throw new Error(result.error ?? "フォルダー情報を保存できませんでした。");
    }
    cachedRecords = next;
    publish(next);
    return next;
  });
  mutationQueue = task.catch(() => undefined);
  return task;
}

function upsert(
  records: FolderActivityRecord[],
  input: FolderActivityInput,
  update: (record: FolderActivityRecord) => FolderActivityRecord,
): FolderActivityRecord[] {
  const relativePath = normalizedPath(input.relativePath);
  const key = folderActivityKey(input.rootId, relativePath);
  const existing = records.find((record) => record.key === key);
  const base: FolderActivityRecord = existing ?? {
    key,
    rootId: input.rootId,
    relativePath,
    displayName: input.displayName,
    rootName: input.rootName,
    itemCount: input.itemCount,
    navigationKey: input.navigationKey,
    visits: 0,
    isFavorite: false,
  };
  const next = update({
    ...base,
    displayName: input.displayName || base.displayName,
    rootName: input.rootName || base.rootName,
    itemCount: Math.max(0, input.itemCount),
    navigationKey: base.isFavorite ? base.navigationKey : input.navigationKey,
  });
  return [next, ...records.filter((record) => record.key !== key)];
}

export function recordFolderVisit(input: FolderActivityInput): Promise<FolderActivityRecord[]> {
  return mutate((records) => upsert(records, input, (record) => ({
    ...record,
    visits: record.visits + 1,
    lastVisitedAt: new Date().toISOString(),
  })));
}

export function setFolderFavorite(
  input: FolderActivityInput,
  isFavorite: boolean,
): Promise<FolderActivityRecord[]> {
  return mutate((records) => upsert(records, input, (record) => ({
    ...record,
    isFavorite,
  })));
}
