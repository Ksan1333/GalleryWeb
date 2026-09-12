import { getJsonPreference, setJsonPreference, type AgeRating } from "./native";

export type GalleryGridSize = "minimum" | "small" | "medium" | "large" | "maximum";
export type GalleryGroupMode = "day" | "month" | "year" | "none";
export type GalleryViewMode = "extra-large-icons" | "large-icons" | "medium-icons" | "small-icons" | "list" | "details";
export type GallerySortOrder =
  | "modified-desc" | "modified-asc" | "name-asc" | "name-desc" | "size-desc" | "size-asc";

export type GalleryDisplayPreferences = {
  gridSize: GalleryGridSize;
  viewMode: GalleryViewMode;
  groupMode: GalleryGroupMode;
  ageRating: AgeRating | "";
  sortOrder: GallerySortOrder;
};

export const galleryDisplayPreferencesKey = "galleryDisplayPreferences";
export const galleryDisplayPreferencesEvent = "pixvault:gallery-display-preferences";
export const defaultGalleryDisplayPreferences: GalleryDisplayPreferences = {
  gridSize: "medium", viewMode: "medium-icons", groupMode: "none", ageRating: "", sortOrder: "modified-desc",
};

export const galleryViewOptions: Array<{ value: GalleryViewMode; label: string }> = [
  { value: "extra-large-icons", label: "特大アイコン" },
  { value: "large-icons", label: "大アイコン" },
  { value: "medium-icons", label: "中アイコン" },
  { value: "small-icons", label: "小アイコン" },
  { value: "list", label: "一覧" },
  { value: "details", label: "詳細" },
];

export function gridSizeForViewMode(viewMode: GalleryViewMode): GalleryGridSize {
  if (viewMode === "extra-large-icons") return "maximum";
  if (viewMode === "large-icons") return "large";
  if (viewMode === "small-icons") return "minimum";
  if (viewMode === "list" || viewMode === "details") return "minimum";
  return "medium";
}

function viewModeForGridSize(gridSize: GalleryGridSize): GalleryViewMode {
  if (gridSize === "maximum") return "extra-large-icons";
  if (gridSize === "large") return "large-icons";
  if (gridSize === "minimum" || gridSize === "small") return "small-icons";
  return "medium-icons";
}

export const galleryGroupOptions: Array<{ value: GalleryGroupMode; label: string }> = [
  { value: "none", label: "なし" },
  { value: "day", label: "更新日ごと" },
  { value: "month", label: "更新月ごと" },
  { value: "year", label: "更新年ごと" },
];

export function normalizeGalleryDisplayPreferences(
  value: Partial<GalleryDisplayPreferences> | null | undefined,
): GalleryDisplayPreferences {
  const gridSize = value?.gridSize;
  const viewMode = value?.viewMode;
  const groupMode = value?.groupMode;
  const sortOrder = value?.sortOrder;
  const normalizedSortOrder: GallerySortOrder = sortOrder === "modified-asc"
    || sortOrder === "name-asc" || sortOrder === "name-desc"
    || sortOrder === "size-desc" || sortOrder === "size-asc" ? sortOrder : "modified-desc";
  const normalizedGroupMode: GalleryGroupMode = groupMode === "day"
    || groupMode === "month" || groupMode === "year" ? groupMode : "none";
  const normalizedGridSize: GalleryGridSize = gridSize === "minimum" || gridSize === "small"
    || gridSize === "large" || gridSize === "maximum" ? gridSize : "medium";
  const normalizedViewMode: GalleryViewMode = viewMode === "extra-large-icons" || viewMode === "large-icons"
    || viewMode === "medium-icons" || viewMode === "small-icons" || viewMode === "list" || viewMode === "details"
    ? viewMode : viewModeForGridSize(normalizedGridSize);
  return {
    gridSize: normalizedGridSize,
    viewMode: normalizedViewMode,
    groupMode: normalizedSortOrder.startsWith("modified-") ? normalizedGroupMode : "none",
    ageRating: value?.ageRating === "UNRATED" || value?.ageRating === "SFW"
      || value?.ageRating === "R15" || value?.ageRating === "R18" ? value.ageRating : "",
    sortOrder: normalizedSortOrder,
  };
}

export function mergeGalleryDisplayPreferences(
  current: GalleryDisplayPreferences,
  patch: Partial<GalleryDisplayPreferences>,
): GalleryDisplayPreferences {
  const adjusted = { ...current, ...patch };
  if (patch.viewMode) adjusted.gridSize = gridSizeForViewMode(patch.viewMode);
  else if (patch.gridSize) adjusted.viewMode = viewModeForGridSize(patch.gridSize);
  if (patch.groupMode && patch.groupMode !== "none" && !adjusted.sortOrder.startsWith("modified-")) {
    adjusted.sortOrder = "modified-desc";
  }
  if (patch.sortOrder && !patch.sortOrder.startsWith("modified-")) adjusted.groupMode = "none";
  const normalized = normalizeGalleryDisplayPreferences(adjusted);
  return patch.gridSize && !patch.viewMode
    ? { ...normalized, gridSize: patch.gridSize }
    : normalized;
}

export async function loadGalleryDisplayPreferences(): Promise<GalleryDisplayPreferences> {
  const result = await getJsonPreference<Partial<GalleryDisplayPreferences>>(
    galleryDisplayPreferencesKey, defaultGalleryDisplayPreferences,
  );
  return normalizeGalleryDisplayPreferences(result.data);
}

export async function saveGalleryDisplayPreferences(
  preferences: GalleryDisplayPreferences,
): Promise<{ saved: boolean; error?: string }> {
  const normalized = normalizeGalleryDisplayPreferences(preferences);
  const result = await setJsonPreference(galleryDisplayPreferencesKey, normalized);
  if (!result.data || result.error) {
    return { saved: false, error: result.error ?? "ギャラリー表示設定を保存できませんでした。" };
  }
  window.dispatchEvent(new CustomEvent(galleryDisplayPreferencesEvent, { detail: normalized }));
  return { saved: true };
}

export const galleryCompactCardWidths: Record<GalleryGridSize, number> = {
  minimum: 88, small: 100, medium: 112, large: 148, maximum: 200,
};
