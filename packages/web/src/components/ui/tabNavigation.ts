export function nextTabIndex(key: string, current: number, length: number): number | undefined {
  if (length === 0 || current < 0) return undefined;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowRight') return (current + 1) % length;
  if (key === 'ArrowLeft') return (current - 1 + length) % length;
  return undefined;
}
