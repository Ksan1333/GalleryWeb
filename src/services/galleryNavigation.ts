export const tagGalleryNavigationEvent = "pixvault:open-tag-gallery";

export type TagGalleryNavigationRequest = {
  requestId: string;
  tagId: string;
  tagName: string;
  scope: "folder" | "all";
  rootId?: string;
  folderPath?: string;
};

export type OpenTagGalleryInput = Omit<TagGalleryNavigationRequest, "requestId">;

export function openTagGallery(input: OpenTagGalleryInput): void {
  const detail: TagGalleryNavigationRequest = {
    ...input,
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    rootId: input.scope === "folder" ? input.rootId : undefined,
    folderPath: input.scope === "folder" ? input.folderPath : undefined,
  };
  window.dispatchEvent(
    new CustomEvent<TagGalleryNavigationRequest>(tagGalleryNavigationEvent, { detail }),
  );
}
