/**
 * One deck of the DJ view (direction B of the prototype): the cover, the
 * names and the tempo heard (BPM after Pitch), the waveform, Play, Cue,
 * Sync and Pitch, then the deck's effects: Filter, the three EQ bands with
 * their kills, Echo. Driven by props (stories); DjPage connects it to
 * player/djDecks.ts.
 */
import { useEffect, useRef } from 'react';
import type { DeckView } from '../../player/djDecks';
import { ECHO_FEEDBACK_MAX, ECHO_TIME, EQ_MAX_DB, dbText, filterText, type DeckFxSettings, type EqBand } from '../../player/deckFx';
import { PITCH_RANGE, deckClock, effectiveBpm, pitchText } from '../../player/deckMath';
import { CoverArt, CueIcon, EmbossIconButton, Fader, Knob, PauseIcon, PlayIcon } from '../ui';
import { Waveform } from './Waveform';
import styles from './DjView.module.css';

export interface DeckHandlers {
  onToggle: () => void;
  onCue: () => void;
  onSync: () => void;
  onPitch: (rate: number) => void;
  onSeek: (sec: number) => void;
  onFilter: (v: number) => void;
  onBand: (band: EqBand, db: number) => void;
  onKill: (band: EqBand) => void;
  onEcho: (patch: Partial<DeckFxSettings['echo']>) => void;
}

export interface DeckProps extends DeckHandlers {
  letter: 'A' | 'B';
  deck: DeckView;
  /** the crossfader favours this deck */
  heard: boolean;
  position: () => number;
}

const BANDS: Array<[EqBand, string]> = [['low', 'Low'], ['mid', 'Mid'], ['high', 'High']];

/** Live (heard, playing), Playing, Loaded, Empty. */
export function deckState(deck: DeckView, heard: boolean): string {
  if (!deck.uid) return 'Empty';
  if (deck.playing) return heard ? 'Live' : 'Playing';
  return 'Loaded';
}

export function Deck({ letter, deck, heard, position, onToggle, onCue, onSync, onPitch, onSeek, onFilter, onBand, onKill, onEcho }: DeckProps) {
  const name = `Deck ${letter}`;
  const bpm = effectiveBpm(deck.bpm, deck.rate);
  const empty = !deck.uid;
  const state = deckState(deck, heard);
  const fx = deck.fx;
  return (
    <section className={styles.deck} aria-label={name} data-live={state === 'Live' ? '' : undefined}>
      <div className={styles.deckHead}>
        <span className={styles.letter}>{name}</span>
        <span className={styles.state} data-on={state === 'Live' ? '' : undefined}>{state}</span>
      </div>
      <div className={styles.top}>
        <CoverArt src={deck.coverUrl} title={deck.album || deck.title || name} compact className={styles.cover} />
        <div className={styles.names}>
          <span className={styles.title} dir="auto">{deck.title || '–'}</span>
          <span className={styles.artist} dir="auto">{deck.artist || '–'}</span>
        </div>
        <div className={styles.bpm}>
          <span className={styles.bpmValue}>{bpm != null ? bpm.toFixed(1) : '–'}</span>
          <span className={styles.bpmLabel}>BPM</span>
        </div>
      </div>
      <Waveform label={`${name} position`} peaks={deck.peaks} durationSec={deck.durationSec} bpm={deck.bpm} firstBeatSec={deck.firstBeatSec} position={position} onSeek={onSeek} />
      <DeckTimes position={position} duration={deck.durationSec} />
      <div className={styles.controls}>
        <EmbossIconButton label={`${deck.playing ? 'Pause' : 'Play'} ${name}`} className={styles.playKey} disabled={empty} onClick={onToggle} aria-busy={deck.loading || undefined}>
          {deck.playing ? <PauseIcon /> : <PlayIcon />}
        </EmbossIconButton>
        <EmbossIconButton label={`Cue ${name}`} disabled={empty} onClick={onCue}><CueIcon /></EmbossIconButton>
        <button type="button" className={styles.toggle} aria-pressed={deck.sync} aria-label={`Sync ${name}`} disabled={empty || deck.bpm == null} onClick={onSync}>Sync</button>
        <div className={styles.pitch}>
          <span className={styles.ctlLabel} aria-hidden="true">Pitch</span>
          <Fader
            label={`${name} pitch`}
            value={Math.round((deck.rate - 1) * 1000) / 10}
            min={-PITCH_RANGE * 100}
            max={PITCH_RANGE * 100}
            step={0.1}
            centred
            defaultValue={0}
            format={(v) => pitchText(1 + v / 100)}
            onChange={(v) => onPitch(1 + v / 100)}
            disabled={empty}
          />
          <span className={styles.ctlValue} aria-hidden="true">{pitchText(deck.rate)}</span>
        </div>
      </div>
      <div className={styles.fx} role="group" aria-label={`${name} effects`}>
        <div className={styles.fxGroup}>
          <span className={styles.fxName} aria-hidden="true">Filter</span>
          <div className={styles.fxKnobs}>
            <Knob label={`${name} filter`} caption="Filter" value={fx.filter} min={-1} max={1} step={0.01} defaultValue={0} format={filterText} onChange={onFilter} />
          </div>
        </div>
        <div className={styles.fxGroup}>
          <span className={styles.fxName} aria-hidden="true">EQ</span>
          <div className={styles.fxKnobs}>
            {BANDS.map(([band, label]) => (
              <div key={band} className={styles.band}>
                <Knob label={`${name} ${label.toLowerCase()}`} caption={label} value={fx.eq[band]} min={-EQ_MAX_DB} max={EQ_MAX_DB} step={0.5} defaultValue={0} format={dbText} onChange={(v) => onBand(band, v)} />
                <button type="button" className={styles.kill} aria-pressed={fx.kills[band]} aria-label={`Kill ${name} ${label.toLowerCase()}`} onClick={() => onKill(band)}>Kill</button>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.fxGroup}>
          <span className={styles.fxName} aria-hidden="true">Echo</span>
          <div className={styles.fxKnobs}>
            <Knob label={`${name} echo time`} caption="Time" value={fx.echo.timeSec} min={ECHO_TIME.min} max={ECHO_TIME.max} step={0.005} defaultValue={0.375} format={(v) => `${Math.round(v * 1000)} ms`} onChange={(v) => onEcho({ timeSec: v })} />
            <Knob label={`${name} echo feedback`} caption="Feedback" value={fx.echo.feedback} min={0} max={ECHO_FEEDBACK_MAX} step={0.01} defaultValue={0.35} format={(v) => `${Math.round((v / ECHO_FEEDBACK_MAX) * 100)} %`} onChange={(v) => onEcho({ feedback: v })} />
            <Knob label={`${name} echo mix`} caption="Mix" value={fx.echo.mix} min={0} max={1} step={0.01} defaultValue={0} format={(v) => (v < 0.005 ? 'Off' : `${Math.round(v * 100)} %`)} onChange={(v) => onEcho({ mix: v })} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** The deck's clock and what is left, updated a few times a second (text, not layout). */
function DeckTimes({ position, duration }: { position: () => number; duration: number | null }) {
  return (
    <div className={styles.times} aria-hidden="true">
      <ClockText get={() => deckClock(position())} />
      <ClockText get={() => (duration ? `-${deckClock(Math.max(0, duration - position()))}` : '-0:00')} />
    </div>
  );
}

function ClockText({ get }: { get: () => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const latest = useRef(get);
  latest.current = get;
  useEffect(() => {
    const write = () => { if (ref.current) { const t = latest.current(); if (ref.current.textContent !== t) ref.current.textContent = t; } };
    write();
    const id = setInterval(write, 250);
    return () => clearInterval(id);
  }, []);
  return <span ref={ref} />;
}
