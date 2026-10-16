/**
 * An icon button drawn as the icon alone, embossed: the glyph looks raised
 * out of the surface (a fine highlight above it, a soft shade under it), with
 * no circle and no key around it. On the page, hover and focus show a niche:
 * a thin recessed outline around the icon's area. In a header (place
 * "header") hover shows no outline. Keyboard focus is a clear ring
 * everywhere.
 *
 * Owner, 2026-10-16 evening: "none of them are circular, they are just
 * elevated icons, as if an emboss of the shape, that has a slight thin
 * stroke around it when hovered (when not in the header) so it's like a
 * niche button". The app's convention for icon buttons from here on; the
 * album page and its header use it first.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import styles from './EmbossIconButton.module.css';

export type EmbossPlace = 'page' | 'header';

/** The classes, for a trigger another component renders (the desktop ⋮ Menu). */
export function embossClassName(place: EmbossPlace = 'page', extra?: string): string {
  return [styles.emboss, place === 'header' ? styles.header : styles.page, extra].filter(Boolean).join(' ');
}

export interface EmbossIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** the accessible name; also the tooltip unless `title` says otherwise */
  label: string;
  /** the icon (an svg in currentColor) */
  children: ReactNode;
  /** on the page (hover shows the niche) or in a header (no hover outline) */
  place?: EmbossPlace;
  ref?: Ref<HTMLButtonElement>;
}

export function EmbossIconButton({ label, children, place = 'page', className, title, type = 'button', ref, ...rest }: EmbossIconButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={embossClassName(place, className)}
    >
      {children}
    </button>
  );
}
