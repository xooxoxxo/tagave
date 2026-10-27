/**
 * File-type handlers (vault "tagave - Core Platform Architecture" §2.3, step 1).
 * A handler owns one kind of file: which names it claims, how its metadata is
 * read (and, when it can be, written) and what identifies a moved copy of it.
 * Apps claim handlers in their manifests (AppManifest.fileTypes, manifest v2):
 * files.handler stores the handler id of each row, the walk indexes only
 * names a handler of an app that is on claims, and scan.parse reads each row
 * with its own handler.
 *
 * There is one handler today, `audio`, claimed by the music app. Sidecars
 * (images, cue sheets, logs, text) are not files yet: they stay in
 * sidecar_files until their handlers come.
 */
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { TagSet } from '@tagave/shared';
import { hashAudioStream } from '../audio/streamHash.js';
import type { TagWriter, WriteOptions } from '../providers/types.js';
import { coreTagsDigest, noNul, tagSnapshotOf } from './audioMetadata.js';
import { APPS } from '../facets/manifests.js';

/**
 * The typed columns of a files row a handler fills when it reads the file.
 * Audio-shaped today (they are audio_files' columns); a handler that has none
 * of them leaves them null.
 */
export interface FileColumns {
  container: string | null;
  codec: string | null;
  lossless: boolean | null;
  durationMs: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  bitrateKbps: number | null;
  hasEmbeddedArt: boolean;
}

/** What a handler read from a file. */
export interface ParsedFile {
  columns: FileColumns;
  /** The handler's metadata snapshot, stored as files.tags_raw (audio: tagSnapshotOf). */
  metadata: unknown;
}

export interface FileTypeHandler {
  /** Stored in files.handler. Never reuse an id for another format. */
  readonly id: string;
  /** Bumped when parse output changes in a way stored rows should be re-read for. */
  readonly version: string;
  /** Lower-case extensions with the dot ('.flac'). */
  readonly extensions: ReadonlySet<string>;
  /** The MIME type of a file with this extension (lower-case, with the dot). */
  mediaType(ext: string): string | null;
  /** Reads the file's columns and metadata. Throws when the file cannot be read as this type. */
  parse(absPath: string): Promise<ParsedFile>;
  /**
   * What identifies a moved copy whose size and mtime changed (move-safe
   * Tier 2), from the stored metadata snapshot; stored in
   * files.core_tags_digest. Null: nothing to go by, never paired on it.
   */
  identityDigest(metadata: unknown): string | null;
  /**
   * What a metadata write must leave unchanged (audio: the audio-stream
   * hash). Absent: the handler's files are never written.
   */
  contentHash?(absPath: string): Promise<string>;
  /** Writes metadata through the file writer (audio: the Mutagen sidecar). Absent: read-only. */
  write?(absPath: string, values: TagSet, writer: TagWriter, opts?: WriteOptions): Promise<void>;
}

/** Lower-case extension with the dot, '' when there is none (a dot file has none). */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

const AUDIO_MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-wavpack',
  '.dsf': 'audio/x-dsf',
  '.dff': 'audio/x-dff',
};

/**
 * Audio files (spec LIB-2): music-metadata reads them, the Mutagen sidecar
 * writes them, the audio-stream hash is what a tag write must not change, and
 * the core tag digest pairs a moved copy.
 */
export const audioHandler: FileTypeHandler = {
  id: 'audio',
  version: '1',
  extensions: new Set(Object.keys(AUDIO_MEDIA_TYPES)),
  mediaType: (ext) => AUDIO_MEDIA_TYPES[ext] ?? null,
  async parse(absPath) {
    const meta = await parseFile(absPath, { duration: true });
    const fmt = meta.format;
    return {
      columns: {
        container: noNul(fmt.container),
        codec: noNul(fmt.codec),
        lossless: fmt.lossless ?? null,
        durationMs: fmt.duration ? Math.round(fmt.duration * 1000) : null,
        sampleRate: fmt.sampleRate ?? null,
        bitDepth: fmt.bitsPerSample ?? null,
        channels: fmt.numberOfChannels ?? null,
        bitrateKbps: fmt.bitrate ? Math.round(fmt.bitrate / 1000) : null,
        hasEmbeddedArt: (meta.common.picture?.length ?? 0) > 0,
      },
      metadata: tagSnapshotOf(meta),
    };
  },
  identityDigest: coreTagsDigest,
  contentHash: (absPath) => hashAudioStream(absPath, path.extname(absPath).toLowerCase().slice(1)),
  write: (absPath, values, writer, opts) => writer.write(absPath, values, opts),
};

/** Every handler this build carries. An id appears once; an extension belongs to one handler. */
export const FILE_TYPE_HANDLERS: readonly FileTypeHandler[] = [audioHandler];

const byId = new Map(FILE_TYPE_HANDLERS.map((h) => [h.id, h]));
const byExt = new Map<string, FileTypeHandler>();
for (const h of FILE_TYPE_HANDLERS) for (const ext of h.extensions) byExt.set(ext, h);

/** The handler a files row names, or null for an id this build does not carry. */
export function fileTypeHandler(id: string | null | undefined): FileTypeHandler | null {
  return (id && byId.get(id)) || null;
}

/**
 * The handler that claims a file name, by extension; null when none does (the
 * walk skips the file). With `claimed`, only those handler ids count.
 */
export function handlerForName(name: string, claimed?: ReadonlySet<string>): FileTypeHandler | null {
  const h = byExt.get(extOf(name)) ?? null;
  return h && (!claimed || claimed.has(h.id)) ? h : null;
}

/** Ids of the handlers an app claims ('music' → ['audio']), from its manifest; [] for an app this build does not have. */
export function handlerIdsOf(app: string): string[] {
  return (APPS.find((a) => a.id === app)?.fileTypes ?? []).filter((id) => byId.has(id));
}

/** Ids of the handlers claimed by the apps that are on (a built-in app always is): what the walk indexes. */
export function claimedHandlerIds(appOn: (appId: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const a of APPS) if (a.builtIn || appOn(a.id)) for (const id of a.fileTypes) if (byId.has(id)) out.add(id);
  return out;
}
