/**
 * Time formatting utilities
 */

/**
 * Humanize seconds to relative time (e.g., "3 min ago")
 */
export function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    const now = Date.now();
    const deltaMs = now - date.getTime();
    const deltaSec = Math.floor(deltaMs / 1000);

    if (deltaSec < 60) return '<1 min ago';
    if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)} min ago`;
    if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)} h ago`;
    return `${Math.floor(deltaSec / 86400)} d ago`;
  } catch {
    return isoString;
  }
}

/**
 * A short date and time: "19 Oct, 22:21", the year only when it is not
 * this one ("3 Mar 2025, 09:10"). `time: false` gives the date alone.
 */
export function shortDate(iso: string | null | undefined, opts: { time?: boolean } = {}): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  if (opts.time === false) return date;
  return `${date}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Humanize ETA in seconds (e.g., "~2 h 10 min", "~35 min", "<1 min")
 */
export function formatEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'calculating...';
  if (seconds < 60) return '<1 min';
  if (seconds < 3600) {
    const mins = Math.round(seconds / 60);
    return `~${mins} min`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return mins > 0 ? `~${hours} h ${mins} min` : `~${hours} h`;
}
