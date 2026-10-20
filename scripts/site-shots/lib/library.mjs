/**
 * The demo library: real releases (track lists from MusicBrainz), every
 * track a FLAC of digital silence at its real length, filed like a real
 * archive (Artist/Year - Album/NN Title.flac). The albums.json cases bend a
 * few albums so each screenshot has something to show.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UA = 'tagave-site-shots/1.0 ( https://github.com/xooxoxxo/tagave )';
const FFMPEG = process.env.FFMPEG ?? (existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** MusicBrainz allows one request a second per client; keep a little under it. */
let lastMbRequest = 0;
async function mbGet(url) {
  const wait = lastMbRequest + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 1; ; attempt++) {
    lastMbRequest = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.ok) return res.json();
    if ((res.status === 503 || res.status === 429) && attempt < 5) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`MusicBrainz ${res.status} for ${url}`);
  }
}

async function release(mbid, cacheDir) {
  const file = path.join(cacheDir, `release-${mbid}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const data = await mbGet(`https://musicbrainz.org/ws/2/release/${mbid}?inc=recordings+artist-credits+release-groups&fmt=json`);
  await writeFile(file, JSON.stringify(data));
  return data;
}

async function frontCover(mbid, cacheDir) {
  const file = path.join(cacheDir, `front-${mbid}.jpg`);
  if (existsSync(file)) return file;
  const res = await fetch(`https://coverartarchive.org/release/${mbid}/front-500`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Cover Art Archive ${res.status} for ${mbid}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const credit = (ac) => (ac ?? []).map((c) => c.name + (c.joinphrase ?? '')).join('');
const safe = (s) => s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+$/, '').replace(/^\.+/, '_');
const pad = (n) => String(n).padStart(2, '0');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))));
  });
}

/** One FLAC of digital silence, `seconds` long, with these Vorbis comments. */
function silentFlac(file, seconds, tags) {
  const meta = Object.entries(tags).filter(([, v]) => v !== undefined && v !== null && v !== '').flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  return run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', seconds.toFixed(3),
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    '-c:a', 'flac', '-compression_level', '8',
    ...meta, file,
  ]);
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/**
 * Builds the library under `musicDir`. Returns a summary per album for the
 * shot script (which folder holds which case).
 */
export async function buildLibrary({ albums, musicDir, cacheDir, log = console.log }) {
  await mkdir(cacheDir, { recursive: true });
  const jobs = [];
  const summary = [];

  for (const entry of albums) {
    const rel = await release(entry.mbid, cacheDir);
    const albumArtist = credit(rel['artist-credit']);
    const original = rel['release-group']?.['first-release-date'] || rel.date || '';
    const year = original.slice(0, 4);
    const discs = rel.media.filter((m) => (m.tracks ?? []).length > 0);
    const missing = new Set(entry.missing ?? []);
    const folders = new Set();
    log(`  ${albumArtist} — ${rel.title} (${year}, ${discs.reduce((n, m) => n + m.tracks.length, 0)} tracks${entry.case ? `, ${entry.case}` : ''})`);

    let cover;
    if (entry.case === 'compilation-split') cover = await frontCover(entry.mbid, cacheDir);

    for (const medium of discs) {
      for (const t of medium.tracks) {
        if (discs.length === 1 && missing.has(t.position)) continue;
        const trackArtist = credit(t['artist-credit']) || albumArtist;
        const seconds = Math.max(5, (t.length ?? t.recording?.length ?? 180_000) / 1000);
        let dir;
        let tags = {
          ARTIST: trackArtist,
          ALBUMARTIST: albumArtist,
          ALBUM: rel.title,
          TITLE: t.title,
          TRACKNUMBER: String(t.position),
          TRACKTOTAL: String(medium.tracks.length),
          DISCNUMBER: String(medium.position),
          DISCTOTAL: String(discs.length),
          DATE: original,
          RELEASEDATE: rel.date || undefined,
          ORIGINALDATE: original,
          MUSICBRAINZ_ALBUMID: rel.id,
          MUSICBRAINZ_RELEASETRACKID: t.id,
          MUSICBRAINZ_TRACKID: t.recording?.id,
        };
        let name = `${pad(t.position)} ${safe(t.title)}.flac`;

        if (entry.case === 'compilation-split') {
          // Ripped long ago and filed under each artist: no MusicBrainz
          // IDs, the track artist as album artist, a folder per artist.
          const first = t['artist-credit']?.[0]?.name ?? trackArtist;
          dir = path.join(safe(first), `${year} - ${safe(rel.title.replace(/: /g, ' - '))}`);
          tags = { ARTIST: trackArtist, ALBUMARTIST: first, ALBUM: rel.title, TITLE: t.title, TRACKNUMBER: String(t.position), DATE: year };
        } else if (entry.case === 'messy-tags') {
          // A hand-tagged rip: lower-case titles, no year or album artist,
          // a placeholder genre. The release ID survived, so identification
          // is still exact.
          dir = path.join(safe(albumArtist), safe(rel.title));
          tags = {
            ARTIST: trackArtist.toLowerCase(),
            ALBUM: rel.title.toLowerCase(),
            TITLE: t.title.toLowerCase(),
            TRACKNUMBER: String(t.position),
            GENRE: 'Other',
            MUSICBRAINZ_ALBUMID: rel.id,
          };
          name = `${pad(t.position)} - ${safe(t.title.toLowerCase())}.flac`;
        } else {
          dir = path.join(safe(albumArtist), `${year} - ${safe(rel.title)}`);
          if (discs.length > 1) dir = path.join(dir, `CD${medium.position}`);
        }
        folders.add(dir);
        jobs.push({ file: path.join(musicDir, dir, name), seconds, tags, cover: cover ? path.join(musicDir, dir, 'cover.jpg') : null, coverSrc: cover });
      }
    }
    summary.push({ ...entry, albumArtist, releaseTitle: rel.title, year, folders: [...folders] });
  }

  for (const dir of new Set(jobs.map((j) => path.dirname(j.file)))) await mkdir(dir, { recursive: true });
  for (const j of jobs) if (j.cover && !existsSync(j.cover)) await writeFile(j.cover, await readFile(j.coverSrc));
  await pool(jobs, 6, (j) => silentFlac(j.file, j.seconds, j.tags));
  log(`  ${jobs.length} files written`);
  return summary;
}
