/**
 * Two persistent desktop bars (rr55, branch-local previews; nothing in the
 * app imports this folder). Each has three states: nothing ever played (the
 * keys and the seek bar there but disabled, the track slot empty), paused on
 * the last track, and playing. Neither has a close key: a bar that is always
 * there has nothing to close (the queue is cleared in Now Playing).
 *
 * A: today's bar, always there: one row (track, keys, seek, queue), 72px,
 *    the volume beside it from 1100px up, as now.
 * B: the Spotify / Qobuz / Tidal layout: track on the left, the keys over
 *    the seek bar in the middle of the pane, queue and volume on the right.
 */
import type { CSSProperties } from 'react';
import { CoverArt, IconButton, NextIcon, PauseIcon, PlayIcon, PreviousIcon, QueueIcon, VolumeIcon } from '../../../components/ui';
import { SeekGlow } from '../../../components/SeekGlow';
import { clock } from '../../../player/logic';
import { COVERS } from '../../adaptiveCovers';
import bar from '../../../components/PlayerBar.module.css';
import s from './bars.module.css';

export type BarState = 'idle' | 'paused' | 'playing';

const TRACK = COVERS.moody;
const DURATION = 321;
const POSITION = { idle: 0, paused: 96, playing: 141 } as const;
const noop = () => undefined;

function Now({ state }: { state: BarState }) {
  if (state === 'idle') return <div className={bar.now} />;
  return (
    <div className={bar.now}>
      <CoverArt src={TRACK.src} title={TRACK.album} compact className={bar.cover} loading="eager" />
      <div className={bar.names}>
        <span className={bar.title}>{TRACK.title}</span>
        <span className={bar.artist}>{TRACK.artist} · {TRACK.album}</span>
      </div>
    </div>
  );
}

function Keys({ state }: { state: BarState }) {
  const idle = state === 'idle';
  return (
    <div className={bar.keys}>
      <IconButton label="Previous track" variant="quiet" size="sm" className={bar.key} onClick={noop} disabled={idle}><PreviousIcon /></IconButton>
      <IconButton label={state === 'playing' ? 'Pause' : 'Play'} variant="secondary" className={bar.playKey} onClick={noop} disabled={idle}>
        {state === 'playing' ? <PauseIcon /> : <PlayIcon />}
      </IconButton>
      <IconButton label="Next track" variant="quiet" size="sm" className={bar.key} onClick={noop} disabled={idle}><NextIcon /></IconButton>
    </div>
  );
}

function Seek({ state, className }: { state: BarState; className?: string | undefined }) {
  const idle = state === 'idle';
  const at = POSITION[state];
  const fill = idle ? 0 : (at / DURATION) * 100;
  return (
    <div className={`${bar.seek} ${className ?? ''}`}>
      <span className={bar.time} aria-hidden="true">{idle ? '-:--' : clock(at)}</span>
      <span className={bar.track} style={{ '--fill': `${fill}%` } as CSSProperties}>
        {state === 'playing' && <SeekGlow playing source="calm" />}
        <input type="range" className={bar.range} min={0} max={idle ? 0 : DURATION} value={at} disabled={idle} aria-label="Seek" onChange={noop} />
      </span>
      <span className={bar.time} aria-hidden="true">{idle ? '-:--' : clock(DURATION)}</span>
    </div>
  );
}

function Volume({ className }: { className: string | undefined }) {
  return (
    <div className={className}>
      <span className={bar.volumeIcon} aria-hidden="true"><VolumeIcon /></span>
      <input type="range" className={bar.range} style={{ '--fill': '80%' } as CSSProperties} min={0} max={100} value={80} aria-label="Volume" onChange={noop} />
    </div>
  );
}

function Queue({ state }: { state: BarState }) {
  return (
    <IconButton label="Queue" variant="quiet" size="sm" className={bar.key} onClick={noop} disabled={state === 'idle'}><QueueIcon /></IconButton>
  );
}

/** A: today's bar, always there; one row. */
export function BarA({ state }: { state: BarState }) {
  return (
    <section className={`${bar.bar} ${s.still}`} aria-label="Player" data-status={state}>
      <Now state={state} />
      <Keys state={state} />
      <Seek state={state} />
      <Volume className={bar.volume} />
      <div className={bar.ends}><Queue state={state} /></div>
    </section>
  );
}

/** B: track left, the keys over the seek bar in the middle, queue and volume right. */
export function BarB({ state }: { state: BarState }) {
  return (
    <section className={`${bar.bar} ${s.still} ${s.barB}`} aria-label="Player" data-status={state}>
      <Now state={state} />
      <div className={s.middle}>
        <Keys state={state} />
        <Seek state={state} className={s.seekB} />
      </div>
      <div className={s.right}>
        <Queue state={state} />
        <Volume className={`${bar.volume} ${s.volumeB}`} />
      </div>
    </section>
  );
}
