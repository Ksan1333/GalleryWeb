import { getJsonPreference, setJsonPreference } from "./native";

export type GalleryMediaVisibility = {
  image: boolean;
  gif: boolean;
  video: boolean;
  book: boolean;
};

export const galleryMediaVisibilityKey = "galleryMediaVisibility";
export const galleryMediaVisibilityEvent = "pixvault:gallery-media-visibility";
export const defaultGalleryMediaVisibility: GalleryMediaVisibility = {
  image: true,
  gif: true,
  video: true,
  book: true,
};

export function normalizeGalleryMediaVisibility(
  value: Partial<GalleryMediaVisibility> | null | undefined,
): GalleryMediaVisibility {
  return {
    image: value?.image !== false,
    gif: value?.gif !== false,
    video: value?.video !== false,
    book: value?.book !== false,
  };
}

export async function loadGalleryMediaVisibility(): Promise<GalleryMediaVisibility> {
  const result = await getJsonPreference<Partial<GalleryMediaVisibility>>(
    galleryMediaVisibilityKey,
    defaultGalleryMediaVisibility,
  );
  return normalizeGalleryMediaVisibility(result.data);
}

export async function saveGalleryMediaVisibility(
  visibility: GalleryMediaVisibility,
): Promise<{ saved: boolean; error?: string }> {
  const normalized = normalizeGalleryMediaVisibility(visibility);
  const result = await setJsonPreference(galleryMediaVisibilityKey, normalized);
  if (!result.data || result.error) {
    return { saved: false, error: result.error ?? "ギャラリーの表示メディアを保存できませんでした。" };
  }
  window.dispatchEvent(new CustomEvent(galleryMediaVisibilityEvent, { detail: normalized }));
  return { saved: true };
}
