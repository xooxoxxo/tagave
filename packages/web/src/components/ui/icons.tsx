/** Small line icons, drawn in currentColor so they take the button's ink. */

/** A curved arrow turning back: undo / revert. */
export function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

/* The player's keys (PlayerBar, the album page). Filled glyphs for the
   transport, line glyphs for close and volume, all in currentColor. */

/** A triangle pointing right: play. */
export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 5.6v12.8c0 .8.9 1.3 1.6.9l10-6.4a1 1 0 0 0 0-1.8l-10-6.4C8.9 4.3 8 4.8 8 5.6z" />
    </svg>
  );
}

/** Two bars: pause. */
export function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
    </svg>
  );
}

/** Two crossing arrows: shuffle (the album in a random order). */
export function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 7h3.2c1.6 0 3.1.8 4 2.1l1.6 2.3 1.6 2.3c.9 1.3 2.4 2.1 4 2.1H20" />
      <path d="M4 17h3.2c1.6 0 3.1-.8 4-2.1M14.4 9.1c.9-1.3 2.4-2.1 4-2.1H20" />
      <path d="M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5" />
    </svg>
  );
}

/** A bar and a triangle pointing left: previous track. */
export function PreviousIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="5" y="5.5" width="2.4" height="13" rx="1" />
      <path d="M18.5 6.6v10.8c0 .8-.9 1.3-1.6.8l-8.2-5.4a1 1 0 0 1 0-1.6l8.2-5.4c.7-.5 1.6 0 1.6.8z" />
    </svg>
  );
}

/** A triangle pointing right and a bar: next track. */
export function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="16.6" y="5.5" width="2.4" height="13" rx="1" />
      <path d="M5.5 6.6v10.8c0 .8.9 1.3 1.6.8l8.2-5.4a1 1 0 0 0 0-1.6L7.1 5.8c-.7-.5-1.6 0-1.6.8z" />
    </svg>
  );
}

/** A thin cross: close. */
export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

/** A speaker with one wave: volume. */
export function VolumeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" />
    </svg>
  );
}

/** Three lines, the last one short with a dot: the play queue. */
export function QueueIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M4 6.5h16M4 12h16M4 17.5h9" />
      <circle cx="18" cy="17.5" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A chevron pointing up: move earlier. */
export function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M6.5 14.5 12 9l5.5 5.5" />
    </svg>
  );
}

/* The album page's icon buttons and its ⋮ drawer (2026-10-16 evening). */

/** Three dots stacked: more actions (⋮). */
export function KebabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="12" cy="5.5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="18.5" r="1.9" />
    </svg>
  );
}

/** A chevron pointing left: back. */
export function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M15 5.5 8.5 12l6.5 6.5" />
    </svg>
  );
}

/** A letter i in a ring: information about the thing. */
export function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A head and shoulders: a person (the artist). */
export function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.8 19.5c1.2-3.3 3.9-5 7.2-5s6 1.7 7.2 5" />
    </svg>
  );
}

/** A record with its label: a physical copy. */
export function DiscIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  );
}

/** A wrench: Maintenance and its tools. */
export function WrenchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7V20h3.3l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.5 2.5-2.4-.6-.6-2.4Z" />
    </svg>
  );
}

/** A chevron pointing down: move later. */
export function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M6.5 9.5 12 15l5.5-5.5" />
    </svg>
  );
}
