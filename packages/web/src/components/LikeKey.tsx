/**
 * The heart (Spotify, Qobuz): an embossed key, no circle. Filled is liked;
 * its name is Like or Unlike. The change shows at once and goes back if the
 * server says no (useToggleLike). LikeKeyView is the key alone, driven by
 * props (stories, tests).
 */
import type { LikeKind } from '@tagave/shared';
import { EmbossIconButton, HeartIcon, type EmbossPlace } from './ui';
import { useLiked, useLikesOn, useToggleLike } from '../hooks/useLikes';
import styles from './LikeKey.module.css';

export interface LikeKeyViewProps {
  liked: boolean;
  onToggle: () => void;
  place?: EmbossPlace;
  /** smaller, for a song row */
  size?: 'md' | 'sm';
  className?: string | undefined;
  disabled?: boolean;
}

export function LikeKeyView({ liked, onToggle, place = 'page', size = 'md', className, disabled }: LikeKeyViewProps) {
  return (
    <EmbossIconButton
      label={liked ? 'Unlike' : 'Like'}
      place={place}
      className={[styles.key, size === 'sm' ? styles.sm : '', className].filter(Boolean).join(' ')}
      data-liked={liked ? '' : undefined}
      data-like-key=""
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
      <HeartIcon filled={liked} />
    </EmbossIconButton>
  );
}

export interface LikeKeyProps extends Omit<LikeKeyViewProps, 'liked' | 'onToggle'> {
  kind: LikeKind;
  id: string | null | undefined;
}

/** The heart of one song, album or artist. Nothing without an id or for a role that cannot like. */
export function LikeKey({ kind, id, ...rest }: LikeKeyProps) {
  const on = useLikesOn();
  const liked = useLiked(kind, id);
  const toggle = useToggleLike();
  if (!on || !id) return null;
  return <LikeKeyView {...rest} liked={liked} onToggle={() => toggle.mutate({ kind, id, like: !liked })} />;
}
