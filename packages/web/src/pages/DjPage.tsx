/**
 * /dj: the DJ view (Advanced mode), opened from Now playing's DJ key or ⌘K
 * `/dj`. While it shows, its decks hold the player's two elements
 * (player/djDecks.ts); leaving it hands playback back to the engine, the
 * heard deck playing on. Where it cannot run (the module off, an iOS
 * home-screen app, casting, another device playing) the route says so as
 * a value.
 *
 * Keys: ←/→ move the crossfader, 1 / 2 / 3 kill the heard deck's low, mid
 * or high, space plays or pauses the heard deck (the player bar's own key).
 */
import { useEffect, useState } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { djUnavailableText, useDjViewAvailability } from '../hooks/useDj';
import { DjHead, DjUnavailable, DjView } from '../components/dj/DjView';
import { PageShell } from '../components/ui';
import type { DeckHandlers } from '../components/dj/Deck';
import { QueuePanel, type QueueTab } from '../components/player/QueuePanel';
import {
  closeDecks, cueDeck, deckPosition, nudgeCrossfader, openDecks, seekDeck, setAutoMix, setCrossfader, setFx, setPitch, toggleDeck, toggleHeardKill, toggleKill, toggleSync,
  useDecks, type DeckIndex,
} from '../player/djDecks';
import { clearQueue, moveInQueue, playAt, removeFromQueue, usePlayerStore } from '../player/engine';
import type { EqBand } from '../player/deckFx';

const KILL_KEYS: Record<string, EqBand> = { 1: 'low', 2: 'mid', 3: 'high' };

/** A key the view takes: not typed into a field, not on a control that uses it itself. */
export function viewKey(e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'defaultPrevented'>, target: Element | null): 'left' | 'right' | EqBand | null {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return null;
  const tag = target?.tagName?.toUpperCase() ?? '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target as HTMLElement | null)?.isContentEditable) return null;
  const role = target?.getAttribute?.('role');
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (role === 'slider' || role === 'radio' || role === 'tab' || target?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]')) return null;
    return e.key === 'ArrowLeft' ? 'left' : 'right';
  }
  return KILL_KEYS[e.key] ?? null;
}

const handlers = (i: DeckIndex): DeckHandlers => ({
  onToggle: () => toggleDeck(i),
  onCue: () => cueDeck(i),
  onSync: () => toggleSync(i),
  onPitch: (rate) => setPitch(i, rate),
  onSeek: (sec) => seekDeck(i, sec),
  onFilter: (v) => setFx(i, { filter: v }),
  onBand: (band, db) => setFx(i, { eq: { [band]: db } }),
  onKill: (band) => toggleKill(i, band),
  onEcho: (patch) => setFx(i, { echo: patch }),
});

export function DjPage() {
  const availability = useDjViewAvailability();
  const navigate = useNavigate();
  const router = useRouter();
  const close = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: '/' });
  };
  const ok = availability === 'ok';
  useEffect(() => {
    if (!ok) return;
    openDecks();
    return () => closeDecks();
  }, [ok]);
  useEffect(() => {
    if (!ok) return;
    const onKey = (e: KeyboardEvent) => {
      const k = viewKey(e, e.target as Element | null);
      if (!k) return;
      e.preventDefault();
      if (k === 'left') nudgeCrossfader(-0.05);
      else if (k === 'right') nudgeCrossfader(0.05);
      else toggleHeardKill(k);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ok]);
  const value = djUnavailableText(availability);
  if (!ok) {
    return (
      <PageShell hero={<DjHead onClose={close} />}>
        {value && <DjUnavailable value={value} />}
      </PageShell>
    );
  }
  return <ConnectedDjView onClose={close} />;
}

function ConnectedDjView({ onClose }: { onClose: () => void }) {
  const state = useDecks();
  const auto = state.auto;
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const [tab, setTab] = useState<QueueTab>('next');
  return (
    <PageShell hero={<DjHead auto={auto} onAuto={setAutoMix} onClose={onClose} />}>
    <DjView
      state={state}
      position={deckPosition}
      deck={handlers}
      onCrossfader={setCrossfader}
      queue={queue && queue.tracks.length > 0 ? (
        <QueuePanel
          tracks={queue.tracks} index={index} context={queue.context} tab={tab} onTab={setTab}
          onPlay={playAt} onMove={moveInQueue} onRemove={removeFromQueue} onClear={clearQueue}
          history={[]} menus
        />
      ) : null}
    />
    </PageShell>
  );
}
