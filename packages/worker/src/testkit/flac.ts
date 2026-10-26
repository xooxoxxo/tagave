/**
 * Tiny tagged FLAC files for tests: fLaC marker, STREAMINFO (44.1 kHz,
 * stereo, 16 bit, a total sample count for the duration), a Vorbis comment
 * block and a padding block that sets the file size. No audio frames:
 * music-metadata reads the duration from STREAMINFO.
 */
import { writeFile } from 'node:fs/promises';

export interface FlacSpec {
  title?: string; artist?: string; album?: string; albumartist?: string;
  track?: number; disc?: number; date?: string;
  seconds?: number; padding?: number; extra?: Record<string, string>;
}

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };

function block(type: number, body: Buffer, last: boolean): Buffer {
  const h = Buffer.alloc(4);
  h[0] = (last ? 0x80 : 0) | type;
  h.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([h, body]);
}

export function flacBytes(spec: FlacSpec): Buffer {
  const sampleRate = 44_100;
  const si = Buffer.alloc(34);
  si.writeUInt16BE(4096, 0);
  si.writeUInt16BE(4096, 2);
  // bytes 4-9: min/max frame size unknown (0)
  const total = BigInt(Math.round((spec.seconds ?? 30) * sampleRate));
  // 20 bits sample rate | 3 bits channels-1 | 5 bits bits-per-sample-1 | 36 bits total samples
  si.writeBigUInt64BE((BigInt(sampleRate) << 44n) | (1n << 41n) | (15n << 36n) | total, 10);
  // bytes 18-33: MD5 of the audio, unknown (0)
  const fields: Record<string, string | undefined> = {
    TITLE: spec.title, ARTIST: spec.artist, ALBUM: spec.album, ALBUMARTIST: spec.albumartist,
    TRACKNUMBER: spec.track?.toString(), DISCNUMBER: spec.disc?.toString(), DATE: spec.date, ...spec.extra,
  };
  const comments = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
  const vendor = Buffer.from('tagave-test', 'utf8');
  const vc = Buffer.concat([u32le(vendor.length), vendor, u32le(comments.length), ...comments.flatMap((c) => [u32le(c.length), c])]);
  return Buffer.concat([Buffer.from('fLaC'), block(0, si, false), block(4, vc, false), block(1, Buffer.alloc(spec.padding ?? 8), true)]);
}

export async function writeFlac(absPath: string, spec: FlacSpec): Promise<void> {
  await writeFile(absPath, flacBytes(spec));
}
