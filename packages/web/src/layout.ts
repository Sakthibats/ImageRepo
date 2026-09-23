import type { ManifestItem } from '@imagerepo/shared';

export interface LaidOutItem {
  item: ManifestItem;
  width: number;
  height: number;
  left: number;
}

export interface Row {
  top: number;
  height: number;
  items: LaidOutItem[];
}

/**
 * Justified rows, the layout Flickr and Google Photos use: fill each row to
 * the container width by scaling a run of images to a shared height, so every
 * photo keeps its aspect ratio and no space is wasted.
 *
 * Computed once per (items, width) and then windowed, which is what makes
 * 13,000 photos scroll smoothly — only visible rows are ever rendered.
 */
export function justify(
  items: ManifestItem[],
  containerWidth: number,
  targetHeight = 240,
  gap = 7,
): { rows: Row[]; totalHeight: number } {
  const rows: Row[] = [];
  let run: ManifestItem[] = [];
  let runRatio = 0;
  let top = 0;

  const flush = (isLast: boolean) => {
    if (!run.length) return;
    const available = containerWidth - gap * (run.length - 1);
    // Scale the run to fill the width, except a trailing row which would
    // otherwise blow a single photo up to full width.
    let height = available / runRatio;
    if (isLast && height > targetHeight * 1.35) height = targetHeight;

    let left = 0;
    const laid: LaidOutItem[] = run.map((it) => {
      const ratio = aspect(it);
      const w = Math.round(height * ratio);
      const entry = { item: it, width: w, height: Math.round(height), left };
      left += w + gap;
      return entry;
    });
    rows.push({ top, height: Math.round(height), items: laid });
    top += Math.round(height) + gap;
    run = [];
    runRatio = 0;
  };

  for (const it of items) {
    run.push(it);
    runRatio += aspect(it);
    // Enough width accumulated to make a row at the target height?
    if (runRatio * targetHeight >= containerWidth - gap * (run.length - 1)) flush(false);
  }
  flush(true);

  return { rows, totalHeight: Math.max(0, top - gap) };
}

function aspect(it: ManifestItem): number {
  const w = it.w || 1;
  const h = it.h || 1;
  const r = w / h;
  // Guard against a missing or absurd dimension poisoning the whole row.
  return Number.isFinite(r) && r > 0.05 && r < 20 ? r : 1.5;
}
