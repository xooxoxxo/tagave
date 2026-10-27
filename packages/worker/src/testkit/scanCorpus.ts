/**
 * The scan fixture corpus: a small library on disk that exercises what a scan
 * does with files (extensions it keeps and skips, sidecar kinds, skipped
 * folders, parse errors, NFD names, a cue image, embedded and sidecar covers,
 * multi-disc and compilation folders) and the moves a rescan reconciles. The
 * scan snapshot test runs the real jobs over it and compares every row they
 * write with a golden file, so a refactor of the scan path must leave the rows
 * exactly as they were.
 *
 * Everything is deterministic: file bytes, names and mtimes are fixed. What a
 * run cannot fix (ids, inodes, timestamps, the temp folder) is normalized by
 * the test, never compared raw.
 */
import { copyFile, mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 16x16 JPEG (sharp, quality 50). Fixed bytes: a platform's encoder never runs. */
export const JPEG_16 = Buffer.from(
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCOACqH/9k=',
  'base64',
);
/** 24x16 PNG. */
export const PNG_24 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAIElEQVQ4jWMQkTtBFcQwapDIaBiJjKYjudEsIkd+OgAAoJp3EMsOIGAAAAAASUVORK5CYII=',
  'base64',
);

/** Fixed file mtimes (seconds): the corpus as written, and files copied later. */
export const CORPUS_MTIME = 1_760_000_000;
export const COPY_MTIME = 1_760_100_000;

interface Flac {
  title?: string | undefined; artist?: string | undefined; album?: string | undefined; albumartist?: string | undefined;
  track?: number | undefined; disc?: number | undefined; date?: string | undefined; seconds?: number | undefined; padding?: number | undefined;
  extra?: Record<string, string> | undefined; picture?: Buffer | undefined;
}

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };

function block(type: number, body: Buffer, last: boolean): Buffer {
  const h = Buffer.alloc(4);
  h[0] = (last ? 0x80 : 0) | type;
  h.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([h, body]);
}

/** A FLAC with STREAMINFO, Vorbis comments, an optional front-cover PICTURE and padding; no audio frames. */
export function corpusFlac(spec: Flac): Buffer {
  const sampleRate = 44_100;
  const si = Buffer.alloc(34);
  si.writeUInt16BE(4096, 0);
  si.writeUInt16BE(4096, 2);
  const total = BigInt(Math.round((spec.seconds ?? 30) * sampleRate));
  si.writeBigUInt64BE((BigInt(sampleRate) << 44n) | (1n << 41n) | (15n << 36n) | total, 10);
  const fields: Record<string, string | undefined> = {
    TITLE: spec.title, ARTIST: spec.artist, ALBUM: spec.album, ALBUMARTIST: spec.albumartist,
    TRACKNUMBER: spec.track?.toString(), DISCNUMBER: spec.disc?.toString(), DATE: spec.date, ...spec.extra,
  };
  const comments = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
  const vendor = Buffer.from('tagave-corpus', 'utf8');
  const vc = Buffer.concat([u32le(vendor.length), vendor, u32le(comments.length), ...comments.flatMap((c) => [u32le(c.length), c])]);
  const blocks = [block(0, si, false), block(4, vc, false)];
  if (spec.picture) {
    const mime = Buffer.from('image/jpeg', 'ascii');
    const pic = Buffer.concat([u32be(3), u32be(mime.length), mime, u32be(0), u32be(16), u32be(16), u32be(24), u32be(0), u32be(spec.picture.length), spec.picture]);
    blocks.push(block(6, pic, false));
  }
  blocks.push(block(1, Buffer.alloc(spec.padding ?? 8), true));
  return Buffer.concat([Buffer.from('fLaC'), ...blocks]);
}

/** A mono 8 kHz 16-bit WAV of `seconds` of silence. */
export function corpusWav(seconds: number): Buffer {
  const data = Buffer.alloc(8000 * 2 * seconds);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(16000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const chunk = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id, 'ascii'), u32le(body.length), body]);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', data)]);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), u32le(body.length), body]);
}

/** ID3v2.3 (title, artist, album, track) and `frames` silent MPEG-1 Layer III frames (128 kb/s, 44.1 kHz). */
export function corpusMp3(tags: { title: string; artist: string; album: string; track: string }, frames: number): Buffer {
  const frame = (id: string, text: string) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const h = Buffer.alloc(10);
    h.write(id, 0, 'ascii');
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const frames3 = Buffer.concat([frame('TIT2', tags.title), frame('TPE1', tags.artist), frame('TALB', tags.album), frame('TRCK', tags.track)]);
  const size = frames3.length;
  const syncsafe = Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const id3 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe, frames3]);
  const mpeg = Buffer.alloc(417);
  mpeg.writeUInt32BE(0xfffb9064, 0);
  return Buffer.concat([id3, ...Array.from({ length: frames }, () => mpeg)]);
}

async function put(abs: string, bytes: Buffer | string, mtime = CORPUS_MTIME): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  await utimes(abs, mtime, mtime);
}

async function album(rootPath: string, dir: string, n: number, o: { album?: string; artist?: string; albumartist?: string; disc?: number; first?: number; artists?: string[]; date?: string } = {}) {
  for (let i = 0; i < n; i++) {
    const t = (o.first ?? 1) + i;
    const artist = o.artists?.[i] ?? o.artist ?? 'Corpus Artist';
    await put(path.join(rootPath, dir, `${String(t).padStart(2, '0')} - Song ${t}.flac`), corpusFlac({
      title: `Song ${t}`, artist, albumartist: o.albumartist ?? o.artist ?? 'Corpus Artist', album: o.album ?? path.basename(dir),
      track: t, disc: o.disc, date: o.date, seconds: 60 + t, padding: 32 + t + dir.length,
    }));
  }
}

/** Writes the corpus as it is before any move: root 0 holds most of it, root 1 one album. */
export async function writeCorpus(roots: [string, string]): Promise<void> {
  const [r0, r1] = roots;
  await album(r0, 'Artist A/Album One (2001)', 3, { artist: 'Artist A', album: 'Album One', date: '2001' });
  await put(path.join(r0, 'Artist A/Album One (2001)/folder.jpg'), JPEG_16);
  await put(path.join(r0, 'Artist A/Album One (2001)/rip.log'), 'EAC log\n');
  await album(r0, 'Artist A/Album Two/CD1', 2, { artist: 'Artist A', album: 'Album Two', disc: 1 });
  await album(r0, 'Artist A/Album Two/CD2', 2, { artist: 'Artist A', album: 'Album Two', disc: 2 });
  await put(path.join(r0, 'Artist A/Album Two/cover.png'), PNG_24);
  await album(r0, 'Artist B/Second', 2, { artist: 'Artist B', album: 'Second' });
  await put(path.join(r0, 'Artist B/Second/front.jpg'), JPEG_16);
  await put(path.join(r0, 'Artist B/Second/list.m3u'), '01 - Song 1.flac\n');
  await album(r0, 'Various/Comp', 3, { albumartist: 'Various Artists', album: 'Comp', artists: ['One', 'Two', 'Three'] });
  await put(path.join(r0, 'Loose/untagged.flac'), corpusFlac({ seconds: 42, padding: 77 }));
  await put(path.join(r0, 'Loose/notes.txt'), 'notes\n');
  await put(path.join(r0, 'Loose/info.nfo'), 'nfo\n');
  await put(path.join(r0, 'Broken/bad.flac'), 'this is not a flac file\n');
  await put(path.join(r0, 'Broken/empty.mp3'), Buffer.alloc(0));
  await put(path.join(r0, 'Embedded/01 - Pic.flac'), corpusFlac({ title: 'Pic', artist: 'Emb', albumartist: 'Emb', album: 'Embedded', track: 1, seconds: 90, picture: JPEG_16 }));
  await put(path.join(r0, 'Image/CDImage.flac'), corpusFlac({ seconds: 300, padding: 99 }));
  await put(path.join(r0, 'Image/CDImage.cue'), [
    'PERFORMER "Cue Artist"', 'TITLE "Cue Album"', 'FILE "CDImage.flac" WAVE',
    '  TRACK 01 AUDIO', '    TITLE "One"', '    PERFORMER "Cue Artist"', '    INDEX 01 00:00:00',
    '  TRACK 02 AUDIO', '    TITLE "Two"', '    PERFORMER "Cue Artist"', '    INDEX 01 02:00:00', '',
  ].join('\n'));
  await put(path.join(r0, 'Formats/01 - Wave.wav'), corpusWav(2));
  await put(path.join(r0, 'Formats/02 - Layer3.mp3'), corpusMp3({ title: 'Layer3', artist: 'Fmt', album: 'Formats', track: '2' }, 12));
  await put(path.join(r0, 'Formats/03 - Loud.FLAC'), corpusFlac({ title: 'Loud', artist: 'Fmt', albumartist: 'Fmt', album: 'Formats', track: 3, seconds: 33 }));
  // NFD on disk, NFC in the index
  await album(r0, 'Unicode/Café Tacvba', 2, { artist: 'Café Tacvba', album: 'Re' });
  // never indexed: skipped folders, files no handler or sidecar kind claims
  await put(path.join(r0, '.hidden/01 - Hidden.flac'), corpusFlac({ title: 'Hidden', track: 1 }));
  await put(path.join(r0, 'Artist A/@eaDir/SYNOPHOTO_THUMB.jpg'), JPEG_16);
  await put(path.join(r0, 'Books/novel.epub'), 'PK epub');
  await put(path.join(r0, 'Books/comic.cbz'), 'PK cbz');
  await put(path.join(r0, 'Books/booklet.pdf'), '%PDF-1.4');
  await put(path.join(r0, 'Video/clip.mkv'), 'mkv');
  await album(r1, 'Other/Album', 2, { artist: 'Other', album: 'Album' });
}

/**
 * The changes the second scan reconciles: a folder rename (Tier 1 by dev:ino),
 * a move to the other root (Tier 1 across roots), a copy with new mtimes and
 * the originals deleted (cluster hold, then Tier 2 by tag digest), a deleted
 * file, a re-tagged file and a new album.
 */
export async function changeCorpus(roots: [string, string]): Promise<void> {
  const [r0, r1] = roots;
  await mkdir(path.join(r0, 'Moved'), { recursive: true });
  await rename(path.join(r0, 'Artist A/Album One (2001)'), path.join(r0, 'Moved/Album One (2001)'));
  await mkdir(path.join(r1, 'Artist B'), { recursive: true });
  await rename(path.join(r0, 'Artist B/Second'), path.join(r1, 'Artist B/Second'));
  await mkdir(path.join(r0, 'Copies/Comp'), { recursive: true });
  for (const n of ['01 - Song 1.flac', '02 - Song 2.flac', '03 - Song 3.flac']) {
    const to = path.join(r0, 'Copies/Comp', n);
    await copyFile(path.join(r0, 'Various/Comp', n), to);
    await utimes(to, COPY_MTIME, COPY_MTIME);
  }
  await rm(path.join(r0, 'Various'), { recursive: true });
  await rm(path.join(r0, 'Loose/untagged.flac'));
  await put(path.join(r0, 'Embedded/01 - Pic.flac'), corpusFlac({ title: 'Pic (retagged)', artist: 'Emb', albumartist: 'Emb', album: 'Embedded', track: 1, seconds: 90, picture: JPEG_16 }), COPY_MTIME);
  await album(r0, 'New/Album', 2, { artist: 'New', album: 'Album' });
}
