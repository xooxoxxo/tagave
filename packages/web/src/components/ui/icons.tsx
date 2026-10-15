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
