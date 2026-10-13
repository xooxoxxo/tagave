/** Shared bits for stories: small icons and the size toolbar value. */
import type { ReactNode } from 'react';

export const PlayIcon = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>;
export const EditIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>;
export const RevertIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12a7 7 0 1 0 2.2-5.1M5 4v3.5h3.5" /></svg>;

/** The Size toolbar ("md" or "sm"). */
export function sizeFrom(globals: Record<string, unknown>): 'md' | 'sm' {
  return globals['size'] === 'sm' ? 'sm' : 'md';
}

/** A row of examples with the app's spacing. */
export function Row({ children, gap = 14 }: { children: ReactNode; gap?: number }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap, alignItems: 'center' }}>{children}</div>;
}

/** A column of examples. */
export function Stack({ children, gap = 16, width }: { children: ReactNode; gap?: number; width?: number }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, alignItems: 'flex-start', maxWidth: width }}>{children}</div>;
}

/** A tiny cover image as a data URI, so stories never hit the network. */
export const COVER_SRC = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5ba8c4"/><stop offset="1" stop-color="#16202a"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="50" cy="50" r="18" fill="none" stroke="#fff" stroke-opacity=".5"/></svg>')}`;
