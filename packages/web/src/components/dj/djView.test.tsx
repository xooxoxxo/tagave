import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Fader, Knob, faderFill, keyValue, knobAngle } from '../ui';
import { DjHead, DjUnavailable, DjView, crossfaderText } from './DjView';
import { deckState } from './Deck';
import { viewKey } from '../../pages/DjPage';
import { djUnavailableText, djViewAvailability } from '../../hooks/useDj';
import { EMPTY_INPUT, suggestions, type GrammarContext } from '../searchGrammar';
import { FX_DEFAULTS, cloneFx } from '../../player/deckFx';
import type { DeckView } from '../../player/djDecks';

const deck = (o: Partial<DeckView> = {}): DeckView => ({
  uid: 'q1', trackId: 't1', title: 'Grid One', artist: 'Metro Nome', album: 'Grid Works', coverUrl: null, durationSec: 30, bpm: 120, firstBeatSec: 1.5, bpmConfidence: 0.95,
  rate: 1, sync: false, playing: false, loading: false, cue: 1.5, peaks: [0.2, 0.5, 0.9], fx: cloneFx(FX_DEFAULTS), ...o,
});
const handlers = () => ({ onToggle() {}, onCue() {}, onSync() {}, onPitch() {}, onSeek() {}, onFilter() {}, onBand() {}, onKill() {}, onEcho() {} });

describe('Knob and Fader', () => {
  it('are sliders with a name and a value as text', () => {
    const k = renderToStaticMarkup(<Knob label="Deck A low" caption="Low" value={-6} min={-12} max={12} step={0.5} defaultValue={0} format={(v) => `${v} dB`} onChange={() => undefined} />);
    expect(k).toContain('role="slider"');
    expect(k).toContain('aria-label="Deck A low"');
    expect(k).toContain('aria-valuetext="-6 dB"');
    expect(k).toContain('tabindex="0"');
    expect(k).toContain('data-away=""');
    const f = renderToStaticMarkup(<Fader label="Crossfader" value={0.25} min={0} max={1} onChange={() => undefined} start="A" end="B" />);
    expect(f).toContain('role="slider"');
    expect(f).toContain('aria-valuenow="0.25"');
    expect(f).toContain('aria-label="Crossfader"');
  });

  it('turn and fill by transform only', () => {
    expect(knobAngle(0, -12, 12)).toBe(0);
    expect(knobAngle(-12, -12, 12)).toBe(-135);
    expect(knobAngle(12, -12, 12)).toBe(135);
    expect(faderFill(0.25, false)).toBe('scaleX(0.25)');
    expect(faderFill(0.75, true)).toBe('translateX(50%) scaleX(0.25)');
    expect(faderFill(0.25, true)).toBe('translateX(25%) scaleX(0.25)');
    const f = renderToStaticMarkup(<Fader label="Pitch" value={2} min={-8} max={8} centred onChange={() => undefined} />);
    expect(f).toMatch(/style="transform:translateX\(62\.5%\)"/);
  });

  it('step by keys: arrows, pages, the ends, and back to rest', () => {
    const k = { value: 0, min: -12, max: 12, unit: 0.5, rest: 0 };
    expect(keyValue('ArrowUp', k)).toBe(0.5);
    expect(keyValue('ArrowLeft', k)).toBe(-0.5);
    expect(keyValue('PageUp', k)).toBe(5);
    expect(keyValue('Home', k)).toBe(-12);
    expect(keyValue('End', k)).toBe(12);
    expect(keyValue('Delete', { ...k, value: 7 })).toBe(0);
    expect(keyValue('a', k)).toBeNull();
    // a fiftieth of the range when that is more than a step
    expect(keyValue('ArrowRight', { value: 0, min: 0, max: 1, unit: 0.005, rest: 0 })).toBeCloseTo(0.02, 10);
  });
});

describe('the DJ view', () => {
  it('shows two decks, the crossfader and the queue, labels and values only', () => {
    const html = renderToStaticMarkup(
      <DjView state={{ x: 0.3, heard: 0, decks: [deck({ playing: true }), deck({ uid: null, title: '' })] }} position={() => 4} deck={handlers} onCrossfader={() => undefined} queue={<ol />} />,
    );
    expect(html).toContain('aria-label="Deck A"');
    expect(html).toContain('aria-label="Deck B"');
    expect(html).toContain('aria-label="Crossfader"');
    expect(html).toContain('aria-label="Deck A pitch"');
    expect(html).toContain('aria-label="Sync Deck A"');
    expect(html).toContain('aria-label="Kill Deck A low"');
    expect(html).toContain('aria-label="Deck A position"');
    expect(html).toContain('120.0');
    expect(html).toContain('Live');
    expect(html).toContain('Empty');
    expect(html).toContain('>Queue<');
  });

  it('shows the tempo heard: the BPM after Pitch', () => {
    const html = renderToStaticMarkup(<DjView state={{ x: 0, heard: 0, decks: [deck({ rate: 1.025 }), deck()] }} position={() => 0} deck={handlers} onCrossfader={() => undefined} />);
    expect(html).toContain('123.0');
    expect(html).toContain('+2.5 %');
  });

  it('names the deck states', () => {
    expect(deckState(deck({ playing: true }), true)).toBe('Live');
    expect(deckState(deck({ playing: true }), false)).toBe('Playing');
    expect(deckState(deck(), true)).toBe('Loaded');
    expect(deckState(deck({ uid: null }), false)).toBe('Empty');
    expect(crossfaderText(0)).toBe('A 100 % · B 0 %');
    expect(crossfaderText(0.5)).toBe('A 71 % · B 71 %');
  });

  it('has Auto mix as Off/On in its header', () => {
    const html = renderToStaticMarkup(<DjHead auto onAuto={() => undefined} onClose={() => undefined} />);
    expect(html).toContain('aria-label="Auto mix"');
    expect(html).toMatch(/checked="" value="on"/);
    expect(html).toContain('aria-label="Close DJ"');
  });

  it('says why when it cannot run here', () => {
    expect(djViewAvailability({ moduleOn: true, availableHere: true, casting: false, remoteDeviceId: null })).toBe('ok');
    expect(djViewAvailability({ moduleOn: false, availableHere: true, casting: false, remoteDeviceId: null })).toBe('off');
    expect(djViewAvailability({ moduleOn: true, availableHere: false, casting: false, remoteDeviceId: null })).toBe('device');
    expect(djViewAvailability({ moduleOn: true, availableHere: true, casting: true, remoteDeviceId: null })).toBe('casting');
    expect(djViewAvailability({ moduleOn: true, availableHere: true, casting: false, remoteDeviceId: 'd2' })).toBe('elsewhere');
    expect(djViewAvailability({ moduleOn: null, availableHere: true, casting: false, remoteDeviceId: null })).toBe('unknown');
    expect(djUnavailableText('device')).toBe('Not on this device');
    expect(djUnavailableText('elsewhere')).toBe('Not on this device');
    expect(djUnavailableText('casting')).toBe('Casting');
    expect(djUnavailableText('ok')).toBeNull();
    expect(renderToStaticMarkup(<DjUnavailable value="Casting" />)).toContain('role="status">Casting<');
  });
});

describe('the DJ view\'s keys', () => {
  const ev = (key: string, more: Partial<KeyboardEvent> = {}) => ({ key, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, ...more });
  const el = (tag: string, role: string | null = null) => ({ tagName: tag, getAttribute: (n: string) => (n === 'role' ? role : null), closest: () => null }) as unknown as Element;

  it('moves the crossfader with ←/→ and kills with 1, 2, 3', () => {
    expect(viewKey(ev('ArrowLeft'), el('DIV'))).toBe('left');
    expect(viewKey(ev('ArrowRight'), null)).toBe('right');
    expect(viewKey(ev('1'), el('BUTTON'))).toBe('low');
    expect(viewKey(ev('2'), null)).toBe('mid');
    expect(viewKey(ev('3'), null)).toBe('high');
  });

  it('leaves fields, sliders, radios and modified keys alone', () => {
    expect(viewKey(ev('ArrowLeft'), el('INPUT'))).toBeNull();
    expect(viewKey(ev('1'), el('TEXTAREA'))).toBeNull();
    expect(viewKey(ev('ArrowLeft'), el('DIV', 'slider'))).toBeNull();
    expect(viewKey(ev('ArrowRight'), el('INPUT', 'radio'))).toBeNull();
    expect(viewKey(ev('1', { metaKey: true }), null)).toBeNull();
    expect(viewKey(ev('ArrowLeft', { defaultPrevented: true }), null)).toBeNull();
    expect(viewKey(ev('4'), null)).toBeNull();
  });
});

describe('⌘K /dj', () => {
  const ctx: GrammarContext = { playlists: true, player: true, dj: true };
  it('offers /dj where the view can run, and only there', () => {
    expect(suggestions({ ...EMPTY_INPUT, text: '/' }, ctx)!.map((s) => s.primary)).toEqual(['/play', '/queue', '/shuffle', '/go', '/theme', '/dj']);
    expect(suggestions({ ...EMPTY_INPUT, text: '/d' }, ctx)).toEqual([{ type: 'command', primary: '/dj', secondary: 'DJ', command: 'dj' }]);
    expect(suggestions({ ...EMPTY_INPUT, text: '/d' }, { ...ctx, dj: false })).toEqual([]);
    expect(suggestions({ ...EMPTY_INPUT, text: '/', scope: 'song' }, ctx)!.map((s) => s.primary)).not.toContain('/dj');
  });
});
