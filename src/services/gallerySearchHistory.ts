import type { GallerySearchFilters } from "../components/GallerySearchModal";
import { getJsonPreference, setJsonPreference } from "./native";

export const searchAndGroupingPreferencesEvent = "pixvault:search-grouping-preferences";
const SEARCH_HISTORY_KEY = "gallery.searchHistory";
const SEARCH_HISTORY_LIMIT_KEY = "gallery.searchHistoryLimit";
const SIMILAR_GROUPING_ENABLED_KEY = "gallery.similarGroupingEnabled";
const SIMILAR_GROUPING_THRESHOLD_KEY = "gallery.similarGroupingThreshold";

export type GallerySearchHistoryEntry = {
  id: string;
  filters: GallerySearchFilters;
  summary: string;
  createdAt: number;
};

export type SearchAndGroupingPreferences = {
  searchHistoryLimit: number;
  similarGroupingEnabled: boolean;
  similarGroupingThreshold: number;
};

export const defaultSearchAndGroupingPreferences: SearchAndGroupingPreferences = {
  searchHistoryLimit: 5,
  similarGroupingEnabled: true,
  similarGroupingThreshold: 60,
};

function copyFilters(filters: GallerySearchFilters): GallerySearchFilters {
  return {
    ...filters,
    query: filters.query.trim(),
    mediaFormats: [...new Set(filters.mediaFormats)],
    tagIds: [...new Set(filters.tagIds)],
  };
}

function meaningful(filters: GallerySearchFilters): boolean {
  return Boolean(
    filters.query.trim()
      || filters.mediaFormats.length
      || filters.rootId
      || filters.folderPath !== undefined
      || filters.ageRating
      || filters.tagIds.length
      || filters.period !== "all",
  );
}

function entrySummary(filters: GallerySearchFilters): string {
  const parts: string[] = [];
  if (filters.query.trim()) parts.push(filters.query.trim());
  if (filters.tagIds.length) parts.push(`タグ ${filters.tagIds.length}件`);
  if (filters.folderPath !== undefined) {
    parts.push(filters.folderPath.split("/").filter(Boolean).pop() ?? "ルート直下");
  } else if (filters.rootId) {
    parts.push("登録フォルダー内");
  }
  if (filters.mediaFormats.length) parts.push(filters.mediaFormats.join(" / ").toUpperCase());
  if (filters.ageRating) parts.push(filters.ageRating);
  if (filters.period !== "all") parts.push(filters.period === "custom" ? "日付指定" : filters.period);
  return parts.slice(0, 4).join(" · ") || "検索条件";
}

function filterIdentity(filters: GallerySearchFilters): string {
  return JSON.stringify({
    ...copyFilters(filters),
    mediaFormats: [...filters.mediaFormats].sort(),
    tagIds: [...filters.tagIds].sort(),
  });
}

function normalizeEntry(value: unknown): GallerySearchHistoryEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<GallerySearchHistoryEntry>;
  const filters = raw.filters;
  if (!filters || typeof filters !== "object" || !Array.isArray(filters.mediaFormats) || !Array.isArray(filters.tagIds)) {
    return undefined;
  }
  const normalized = copyFilters({
    mediaFormats: filters.mediaFormats.filter((value): value is GallerySearchFilters["mediaFormats"][number] =>
      ["image", "gif", "video", "book"].includes(value),
    ),
    rootId: typeof filters.rootId === "string" ? filters.rootId : undefined,
    folderPath: typeof filters.folderPath === "string" ? filters.folderPath : undefined,
    ageRating: ["UNRATED", "SFW", "R15", "R18"].includes(filters.ageRating ?? "")
      ? filters.ageRating
      : undefined,
    tagIds: filters.tagIds.filter((value): value is string => typeof value === "string"),
    query: typeof filters.query === "string" ? filters.query : "",
    period: ["all", "today", "7days", "30days", "year", "custom"].includes(filters.period)
      ? filters.period
      : "all",
    customFrom: typeof filters.customFrom === "string" ? filters.customFrom : undefined,
    customTo: typeof filters.customTo === "string" ? filters.customTo : undefined,
  });
  if (!meaningful(normalized)) return undefined;
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
    ? raw.createdAt
    : Date.now();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : `${createdAt}-${filterIdentity(normalized)}`,
    filters: normalized,
    summary: typeof raw.summary === "string" && raw.summary ? raw.summary : entrySummary(normalized),
    createdAt,
  };
}

export async function loadSearchAndGroupingPreferences(): Promise<SearchAndGroupingPreferences> {
  const [limit, enabled, threshold] = await Promise.all([
    getJsonPreference(SEARCH_HISTORY_LIMIT_KEY, defaultSearchAndGroupingPreferences.searchHistoryLimit),
    getJsonPreference(SIMILAR_GROUPING_ENABLED_KEY, defaultSearchAndGroupingPreferences.similarGroupingEnabled),
    getJsonPreference(SIMILAR_GROUPING_THRESHOLD_KEY, defaultSearchAndGroupingPreferences.similarGroupingThreshold),
  ]);
  return {
    searchHistoryLimit: Math.max(1, Math.min(10, Math.round(Number(limit.data) || 5))),
    similarGroupingEnabled: Boolean(enabled.data),
    similarGroupingThreshold: Math.max(1, Math.min(100, Math.round(Number(threshold.data) || 60))),
  };
}

export async function saveSearchAndGroupingPreferences(
  preferences: SearchAndGroupingPreferences,
): Promise<boolean> {
  const normalized: SearchAndGroupingPreferences = {
    searchHistoryLimit: Math.max(1, Math.min(10, Math.round(preferences.searchHistoryLimit))),
    similarGroupingEnabled: Boolean(preferences.similarGroupingEnabled),
    similarGroupingThreshold: Math.max(1, Math.min(100, Math.round(preferences.similarGroupingThreshold))),
  };
  const results = await Promise.all([
    setJsonPreference(SEARCH_HISTORY_LIMIT_KEY, normalized.searchHistoryLimit),
    setJsonPreference(SIMILAR_GROUPING_ENABLED_KEY, normalized.similarGroupingEnabled),
    setJsonPreference(SIMILAR_GROUPING_THRESHOLD_KEY, normalized.similarGroupingThreshold),
  ]);
  if (results.some((result) => !result.data || result.error)) return false;
  const history = await loadGallerySearchHistory();
  if (history.length > normalized.searchHistoryLimit) {
    await setJsonPreference(SEARCH_HISTORY_KEY, history.slice(0, normalized.searchHistoryLimit));
  }
  window.dispatchEvent(new CustomEvent(searchAndGroupingPreferencesEvent, { detail: normalized }));
  return true;
}

export async function loadGallerySearchHistory(): Promise<GallerySearchHistoryEntry[]> {
  const [history, preferences] = await Promise.all([
    getJsonPreference<unknown[]>(SEARCH_HISTORY_KEY, []),
    loadSearchAndGroupingPreferences(),
  ]);
  return (Array.isArray(history.data) ? history.data : [])
    .map(normalizeEntry)
    .filter((entry): entry is GallerySearchHistoryEntry => Boolean(entry))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, preferences.searchHistoryLimit);
}

export async function rememberGallerySearch(
  filters: GallerySearchFilters,
): Promise<GallerySearchHistoryEntry[]> {
  const normalized = copyFilters(filters);
  if (!meaningful(normalized)) return loadGallerySearchHistory();
  const [current, preferences] = await Promise.all([
    loadGallerySearchHistory(),
    loadSearchAndGroupingPreferences(),
  ]);
  const identity = filterIdentity(normalized);
  const entry: GallerySearchHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filters: normalized,
    summary: entrySummary(normalized),
    createdAt: Date.now(),
  };
  const next = [entry, ...current.filter((item) => filterIdentity(item.filters) !== identity)]
    .slice(0, preferences.searchHistoryLimit);
  await setJsonPreference(SEARCH_HISTORY_KEY, next);
  return next;
}

export async function removeGallerySearchHistory(id: string): Promise<GallerySearchHistoryEntry[]> {
  const current = await loadGallerySearchHistory();
  const next = current.filter((entry) => entry.id !== id);
  await setJsonPreference(SEARCH_HISTORY_KEY, next);
  return next;
}

export async function clearGallerySearchHistory(): Promise<void> {
  await setJsonPreference(SEARCH_HISTORY_KEY, []);
}
