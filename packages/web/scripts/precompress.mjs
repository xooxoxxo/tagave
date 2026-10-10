/**
 * Writes .br and .gz next to every compressible file in dist/ after
 * `vite build`, so the API serves them with @fastify/static preCompressed
 * instead of compressing on each request (or not at all: before this, prod
 * sent the 1 MB bundle uncompressed, audit 2026-10-10). Node's zlib only;
 * no build plugin. A file is skipped when compression saves under 10 %.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

const dist = new URL('../dist/', import.meta.url).pathname;
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.webmanifest']);

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else yield p;
  }
}

let raw = 0, br = 0, gz = 0, count = 0;
for await (const file of files(dist)) {
  if (!COMPRESSIBLE.has(extname(file))) continue;
  const input = await readFile(file);
  if (input.length < 1024) continue;
  const b = brotliCompressSync(input, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: input.length },
  });
  const g = gzipSync(input, { level: 9 });
  if (b.length < input.length * 0.9) await writeFile(`${file}.br`, b);
  if (g.length < input.length * 0.9) await writeFile(`${file}.gz`, g);
  raw += input.length; br += b.length; gz += g.length; count++;
}
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`precompress: ${count} files, ${kb(raw)} → brotli ${kb(br)}, gzip ${kb(gz)}`);
