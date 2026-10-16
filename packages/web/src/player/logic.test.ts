/**
 * The player's rules: the queue order and what next / previous / play from
 * here do around tracks that are not on the player, the stream format a
 * browser gets, transcoded seeking, failures, and when Space belongs to the
 * player.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerQueueTrack } from '@tagave/shared';
import {
  scanWaitLine,
  chooseFormat, classifyFailure, clock, firstPlayableFrom, heardDelta, nextPlayable, nothingPlayableMessage, orderQueue, parseQuality,
  handoffDelayMs, moveUpcoming, previousAction, previousPlayable, removeUpcoming, seekPlan, shouldPreload, shownDuration, shownPosition, spaceTogglesPlayback, startIndex, streamUrl,
  transcodeFormat, type CanPlay, type KeyTarget,
} from './logic';

const track = (id: string, discNo: number, trackNo: number | null, available = true, extra: Partial<PlayerQueueTrack> = {}): PlayerQueueTrack => ({
  localTrackId: id, discNo, trackNo, title: `Track ${id}`, artist: 'Artist', album: 'Album', albumArtist: 'Artist',
  durationMs: 200_000, container: 'flac', codec: 'flac', lossless: true, mime: 'audio/flac',
  available, reason: available ? null : 'not_scanned', ...extra,
});

describe('the queue', () => {
  // disc 1: a b(unavailable) c ; disc 2: d(unavailable) e
  const q = [track('a', 1, 1), track('b', 1, 2, false), track('c', 1, 3), track('d', 2, 1, false), track('e', 2, 2)];

  it('next skips tracks that are not on the player, across discs', () => {
    expect(nextPlayable(q, 0)).toBe(2);
    expect(nextPlayable(q, 2)).toBe(4);
    expect(nextPlayable(q, 4)).toBe(-1);
  });

  it('previous skips them too', () => {
    expect(previousPlayable(q, 4)).toBe(2);
    expect(previousPlayable(q, 2)).toBe(0);
    expect(previousPlayable(q, 0)).toBe(-1);
  });

  it('previous restarts after 3 s, otherwise goes back (and restarts the first track)', () => {
    expect(previousAction(q, 4, 3.5)).toEqual({ kind: 'restart' });
    expect(previousAction(q, 4, 2)).toEqual({ kind: 'go', index: 2 });
    expect(previousAction(q, 0, 1)).toEqual({ kind: 'restart' });
  });

  it('play starts at the first playable track; play from here at that track or the next playable one', () => {
    const lead = [track('x', 1, 1, false), ...q];
    expect(startIndex(lead)).toBe(1);
    expect(startIndex(q, 'c')).toBe(2);
    expect(startIndex(q, 'b')).toBe(2);
    expect(startIndex(q, 'd')).toBe(4);
    expect(startIndex(q, 'unknown')).toBe(0);
    expect(startIndex([track('z', 1, 1, false)])).toBe(-1);
    expect(firstPlayableFrom(q, 5)).toBe(-1);
  });

  it('keeps one continuous queue in disc, then track order', () => {
    const shuffled = [track('e', 2, 2), track('a', 1, 1), track('d', 2, 1), track('n', 1, null), track('c', 1, 3)];
    expect(orderQueue(shuffled).map((t) => t.localTrackId)).toEqual(['a', 'c', 'n', 'd', 'e']);
  });

  it('says plainly why nothing can be played', () => {
    expect(nothingPlayableMessage({ scanRequested: true, tracks: [track('a', 1, 1, false)] }))
      .toBe('Not on the player yet — tagave asked it to look for these files. Try again in a minute.');
    const first = { scanning: true, firstScan: true, count: 9500, total: 28000, percent: 33 };
    expect(nothingPlayableMessage({ scanRequested: true, tracks: [track('a', 1, 1, false)], scan: first }))
      .toBe('Not on the player yet — its first scan is at 33\u202f%.');
    expect(nothingPlayableMessage({ scanRequested: false, tracks: [track('a', 1, 1, false)], scan: { ...first, percent: null } }))
      .toBe('Not on the player yet — its first scan is still running.');
    expect(nothingPlayableMessage({ scanRequested: false, tracks: [track('a', 1, 1, false)], scan: { ...first, firstScan: false, total: null, percent: null } }))
      .toBe('Not on the player yet — it is scanning for new files.');
    // missing files are not a scan's business
    expect(nothingPlayableMessage({ scanRequested: false, tracks: [track('a', 1, 1, false, { reason: 'no_file' })], scan: first }))
      .toBe('The files for these tracks are missing or could not be read.');
    expect(nothingPlayableMessage({ scanRequested: false, tracks: [track('a', 1, 1, false, { reason: 'cue' })] }))
      .toBe('Tracks inside a CUE image cannot be played yet.');
    expect(nothingPlayableMessage({ scanRequested: false, tracks: [] })).toBe('This album has no tracks to play.');
  });
});

describe('the album page while the player scans', () => {
  it('says when the album will be playable, quietly', () => {
    expect(scanWaitLine(null)).toBeNull();
    expect(scanWaitLine({ scanning: false, firstScan: false, count: 10, total: null, percent: null })).toBeNull();
    expect(scanWaitLine({ scanning: true, firstScan: true, count: 9500, total: 28000, percent: 34 })).toBe('On the player after its first scan (34\u202f%)');
    expect(scanWaitLine({ scanning: true, firstScan: true, count: null, total: 28000, percent: null })).toBe('On the player after its first scan');
    expect(scanWaitLine({ scanning: true, firstScan: false, count: 12, total: null, percent: null })).toBe('On the player after the scan it is running');
  });
});

describe('the stream format', () => {
  const browser = (answers: Record<string, string>): CanPlay => (type) => answers[type] ?? '';
  const chrome = browser({ 'audio/flac': 'probably', 'audio/ogg; codecs="opus"': 'probably', 'audio/aac': 'probably' });
  const safari = browser({ 'audio/aac': 'maybe', 'audio/mp4; codecs="mp4a.40.2"': 'probably' });
  const old = browser({});
  const auto = { format: 'auto', bitrate: 192 } as const;

  it('auto plays the original when the browser can', () => {
    expect(chooseFormat(auto, 'audio/flac', chrome)).toBe('original');
  });

  it('auto transcodes otherwise: opus, then AAC, then MP3', () => {
    expect(chooseFormat(auto, 'audio/x-ape', chrome)).toBe('opus');
    expect(chooseFormat(auto, 'audio/flac', safari)).toBe('aac');
    expect(chooseFormat(auto, 'audio/flac', old)).toBe('mp3');
    expect(chooseFormat(auto, null, chrome)).toBe('opus');
    expect(transcodeFormat(browser({ 'audio/mp4; codecs="mp4a.40.2"': 'maybe' }))).toBe('aac');
  });

  it('an explicit choice forces the format', () => {
    expect(chooseFormat({ format: 'mp3', bitrate: 128 }, 'audio/flac', chrome)).toBe('mp3');
    expect(chooseFormat({ format: 'original', bitrate: 128 }, 'audio/x-ape', old)).toBe('original');
  });

  it('builds the stream URL with the bitrate and offset only for a transcode', () => {
    expect(streamUrl('t1', 'original', 192, 30)).toBe('/api/v1/player/stream/t1?format=original');
    expect(streamUrl('t1', 'opus', 160, 0)).toBe('/api/v1/player/stream/t1?format=opus&maxBitRate=160');
    expect(streamUrl('t1', 'mp3', 320, 61.7)).toBe('/api/v1/player/stream/t1?format=mp3&maxBitRate=320&offset=61');
  });

  it('reads only valid stored choices', () => {
    expect(parseQuality('{"format":"opus","bitrate":128}')).toEqual({ format: 'opus', bitrate: 128 });
    expect(parseQuality('{"format":"wav","bitrate":100}')).toEqual({ format: 'auto', bitrate: 192 });
    expect(parseQuality('not json')).toEqual({ format: 'auto', bitrate: 192 });
    expect(parseQuality(null)).toEqual({ format: 'auto', bitrate: 192 });
  });
});

describe('seeking', () => {
  it('the original seeks natively', () => {
    expect(seekPlan('original', 42.5, 200)).toEqual({ kind: 'native', time: 42.5 });
  });

  it('a transcode reloads from a whole second, clamped to the track', () => {
    expect(seekPlan('opus', 42.9, 200)).toEqual({ kind: 'reload', offset: 42 });
    expect(seekPlan('aac', -5, 200)).toEqual({ kind: 'reload', offset: 0 });
    expect(seekPlan('mp3', 500, 200)).toEqual({ kind: 'reload', offset: 199 });
  });

  it('after a reload the shown time counts from the offset, and the length stays the track’s', () => {
    // reloaded at 120 s, the element has played 5.5 s of the new stream
    expect(shownPosition(120, 5.5)).toBe(125.5);
    expect(shownPosition(120, Number.NaN)).toBe(120);
    // the element only knows the remainder of a transcode (80 s); the tag knows the track (200 s)
    expect(shownDuration('opus', 200_000, 80)).toBe(200);
    expect(shownDuration('original', 200_000, 199.4)).toBe(199.4);
    expect(shownDuration('original', 200_000, Number.POSITIVE_INFINITY)).toBe(200);
    expect(shownDuration('mp3', null, 80)).toBeNull();
  });

  it('counts only small forward steps as heard (seeks do not count)', () => {
    expect(heardDelta(null, 10)).toBe(0);
    expect(heardDelta(10, 10.25)).toBeCloseTo(0.25);
    expect(heardDelta(10, 70)).toBe(0);
    expect(heardDelta(70, 10)).toBe(0);
  });

  it('preloads the next track in the last 30 s, or at once for a short track', () => {
    expect(shouldPreload(100, 200)).toBe(false);
    expect(shouldPreload(171, 200)).toBe(true);
    expect(shouldPreload(169, 200)).toBe(false);
    expect(shouldPreload(0, 25)).toBe(true);
    expect(shouldPreload(0, null)).toBe(false);
  });

  it('prints times as m:ss, h:mm:ss past an hour', () => {
    expect(clock(83)).toBe('1:23');
    expect(clock(296.9)).toBe('4:56');
    expect(clock(3723)).toBe('1:02:03');
    expect(clock(null)).toBe('0:00');
  });
});

describe('a stream that fails', () => {
  it('skips a track that is not on the player yet (409)', () => {
    expect(classifyFailure({ probe: 409, format: 'original', triedFallback: false })).toBe('skip');
  });
  it('retries an original that reached the browser but would not decode, once, as a transcode', () => {
    expect(classifyFailure({ probe: 206, format: 'original', triedFallback: false })).toBe('fallback');
    expect(classifyFailure({ probe: 206, format: 'original', triedFallback: true })).toBe('failed');
    expect(classifyFailure({ probe: 200, format: 'opus', triedFallback: false })).toBe('failed');
  });
  it('shows too many streams (429) and an unreachable server as errors with Retry', () => {
    expect(classifyFailure({ probe: 429, format: 'original', triedFallback: false })).toBe('busy');
    expect(classifyFailure({ probe: null, format: 'mp3', triedFallback: false })).toBe('network');
  });
});

describe('Space', () => {
  const space = { key: ' ', code: 'Space' };
  const el = (tagName: string, extra: Partial<KeyTarget> & { inside?: boolean } = {}): KeyTarget => ({
    tagName, ...extra, closest: (sel: string) => (extra.inside || /\bbutton\b/.test(sel) && tagName === 'BUTTON' ? {} : null),
  });

  it('toggles playback on the page itself while a queue exists', () => {
    expect(spaceTogglesPlayback(space, el('BODY'), true)).toBe(true);
    expect(spaceTogglesPlayback(space, el('DIV'), true)).toBe(true);
    expect(spaceTogglesPlayback(space, null, true)).toBe(true);
  });

  it('does nothing without a queue, with modifiers or on key repeat', () => {
    expect(spaceTogglesPlayback(space, el('BODY'), false)).toBe(false);
    expect(spaceTogglesPlayback({ ...space, shiftKey: true }, el('BODY'), true)).toBe(false);
    expect(spaceTogglesPlayback({ ...space, repeat: true }, el('BODY'), true)).toBe(false);
    expect(spaceTogglesPlayback({ key: 'k' }, el('BODY'), true)).toBe(false);
  });

  it('leaves Space to fields and to controls Space presses', () => {
    expect(spaceTogglesPlayback(space, el('INPUT', { type: 'text' }), true)).toBe(false);
    expect(spaceTogglesPlayback(space, el('INPUT', { type: 'checkbox' }), true)).toBe(false);
    expect(spaceTogglesPlayback(space, el('TEXTAREA'), true)).toBe(false);
    expect(spaceTogglesPlayback(space, el('SELECT'), true)).toBe(false);
    expect(spaceTogglesPlayback(space, el('BUTTON'), true)).toBe(false);
    expect(spaceTogglesPlayback(space, el('DIV', { isContentEditable: true }), true)).toBe(false);
    // a link, a role="button" or a span inside a button
    expect(spaceTogglesPlayback(space, el('SPAN', { inside: true }), true)).toBe(false);
  });

  it('keeps Space on the seek and volume sliders for the player', () => {
    expect(spaceTogglesPlayback(space, el('INPUT', { type: 'range' }), true)).toBe(true);
  });
});

describe('editing the queue', () => {
  const q = ['a', 'b', 'c', 'd', 'e'];
  it('moves only upcoming tracks, within the upcoming ones', () => {
    expect(moveUpcoming(q, 1, 4, 2)).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(moveUpcoming(q, 1, 2, 3)).toEqual(['a', 'b', 'd', 'c', 'e']);
    // the playing track and the ones before it stay put
    expect(moveUpcoming(q, 1, 1, 3)).toBe(q);
    expect(moveUpcoming(q, 1, 3, 0)).toBe(q);
    expect(moveUpcoming(q, 1, 3, 9)).toBe(q);
  });
  it('removes only upcoming tracks', () => {
    expect(removeUpcoming(q, 1, 3)).toEqual(['a', 'b', 'c', 'e']);
    expect(removeUpcoming(q, 1, 1)).toBe(q);
    expect(removeUpcoming(q, 1, 0)).toBe(q);
  });
});

describe('near-gapless track changes', () => {
  it('starts the next track just before the end, once it is loaded and playing', () => {
    expect(handoffDelayMs(199.5, 200, true, false)).toBe(450);
    expect(handoffDelayMs(199.97, 200, true, false)).toBe(0);
    expect(handoffDelayMs(190, 200, true, false)).toBeNull();
    expect(handoffDelayMs(199.5, 200, false, false)).toBeNull();
    expect(handoffDelayMs(199.5, 200, true, true)).toBeNull();
    expect(handoffDelayMs(0.5, 0.8, true, false)).toBeNull();
    expect(handoffDelayMs(10, null, true, false)).toBeNull();
  });
});
