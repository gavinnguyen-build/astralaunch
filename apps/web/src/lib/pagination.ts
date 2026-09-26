/** Pagination helpers (Discover). */

/** Page numbers with ellipses: 1 2 3 … 8 / 1 … 4 5 6 … 8 / 1 … 6 7 8. */
export function pageItems(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3].forEach((p) => keep.add(p));
  if (page >= pages - 2) [pages - 2, pages - 1].forEach((p) => keep.add(p));
  const sorted = [...keep].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  sorted.forEach((p, i) => { if (i > 0 && p - sorted[i - 1]! > 1) out.push('…'); out.push(p); });
  return out;
}
