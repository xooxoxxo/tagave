/** scrollLeft that centres an item in a horizontally scrolling row, clamped to the row. */
export function centeredScrollLeft(scrollWidth: number, clientWidth: number, itemLeft: number, itemWidth: number): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  const target = itemLeft - (clientWidth - itemWidth) / 2;
  return Math.round(Math.min(max, Math.max(0, target)));
}
