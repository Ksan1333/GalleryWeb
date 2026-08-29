import { getJsonPreference } from "./native";

export type GalleryMediaVisibility = {
  video: boolean;
  book: boolean;
};

export const galleryMediaVisibilityKey = "galleryMediaVisibility";
export const galleryMediaVisibilityEvent = "pixvault:gallery-media-visibility";
export const defaultGalleryMediaVisibility: GalleryMediaVisibility = {
  video: true,
  book: true,
};

export function normalizeGalleryMediaVisibility(
  value: Partial<GalleryMediaVisibility> | null | undefined,
): GalleryMediaVisibility {
  return {
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
