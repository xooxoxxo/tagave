import type { IAudioMetadata } from 'music-metadata';

/**
 * audio_files.tags_raw: music-metadata's common block plus the native frames
 * per tag type, pictures stripped. scan.parse and tags.apply both store this
 * shape; everything that reads tags_raw (identify, preview, lint) expects
 * `common` under this key, so a writer that stores the bare common block
 * makes every later reader see an untagged file.
 */
export function tagSnapshotOf(meta: IAudioMetadata): { common: Record<string, unknown>; native: Record<string, { id: string; value: unknown }[]> } {
  const common = safeJson({ ...meta.common }) as Record<string, unknown>;
  delete common['picture'];
  const native: Record<string, { id: string; value: unknown }[]> = {};
  for (const [tagType, frames] of Object.entries(meta.native)) {
    native[tagType] = frames
      .filter((f) => !/^APIC|PIC|covr|METADATA_BLOCK_PICTURE$/i.test(f.id))
      .map((f) => ({ id: f.id, value: safeJson(f.value) }));
  }
  return { common, native };
}

/** jsonb-safe conversion for native frame values (Buffers → summaries). */
function safeJson(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  // Postgres jsonb cannot store \u0000 inside strings; old rips carry them.
  if (typeof v === 'string') return v.replaceAll('\u0000', '');
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<binary ${v.length}B>`;
  if (Array.isArray(v)) return v.map(safeJson);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = safeJson(val);
    return out;
  }
  return String(v);
}
