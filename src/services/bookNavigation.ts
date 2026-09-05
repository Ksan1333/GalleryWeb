export type BookReadingBinding = "left" | "right";

export function bookSeekPosition(pageIndex: number, pageCount: number, binding: BookReadingBinding): number {
  const progress = pageCount > 1 ? Math.max(0, Math.min(1, pageIndex / (pageCount - 1))) : 0;
  return (binding === "right" ? 1 - progress : progress) * 100;
}

/** Physical arrow direction follows the book's binding, including the seek control. */
export function bookSeekKeyPage(key: string, pageIndex: number, pageCount: number, binding: BookReadingBinding, step = 1): number | undefined {
  const last = Math.max(0, pageCount - 1);
  if (key === "Home") return 0;
  if (key === "End") return last;
  let delta: number;
  if (key === "ArrowLeft") delta = binding === "right" ? step : -step;
  else if (key === "ArrowRight") delta = binding === "right" ? -step : step;
  else if (key === "ArrowUp") delta = step;
  else if (key === "ArrowDown") delta = -step;
  else if (key === "PageUp") delta = -10 * step;
  else if (key === "PageDown") delta = 10 * step;
  else return undefined;
  return Math.max(0, Math.min(last, pageIndex + delta));
}
