# Site screenshots

The landing page shots in `site/img/` come from one command, so they can be
taken again for each release:

```sh
pnpm install && pnpm -r build
node scripts/site-shots/run.mjs
```

It takes about seven minutes and needs Docker (for Postgres only), ffmpeg and
network access to MusicBrainz and the Cover Art Archive.

What it does:

1. **Builds a demo library** in a temporary folder: the releases in
   [`albums.json`](albums.json), with track lists from the MusicBrainz API
   (one request a second, cached for the run). Every track is a FLAC of digital
   silence at its real length, tagged with the release's MusicBrainz IDs and
   filed as `Artist/Year - Album/NN Title.flac`. A few albums are bent on
   purpose (the `case` field): one with messy tags for the tag plan, two with
   missing tracks for Library care, one double album in `CD1`/`CD2` folders,
   and a compilation filed one folder per artist.
2. **Starts a throwaway tagave** from this checkout's build: a `postgres:16`
   container named `siteshots-<id>` (data on tmpfs, no volume, free port on
   127.0.0.1), the API and the worker as child processes. It creates the
   owner `demo@example.com` with a random password that is never written down,
   adds the library as the scan root "Music", scans, and waits until the
   worker is idle after identification, enrichment, cover art and gaps.
   It then previews a tag plan, gathers critic scores for one album and
   rates it and logs a listen.
3. **Captures** each shot with Playwright at 1600 px wide and 2x pixel
   density, in light and dark, and writes
   `site/img/<shot>-<light|dark>-<1600|800>.webp` (sharp, quality 82).
   A shot that shows an error, a warning banner or a local path fails the run.

Shots: `compilation`, `albums`, `plan`, `gaps`, `album`, `reviews`.

Options:

- `--only albums,plan` captures only those shots.
- `--hold` stops after the library is ready and keeps tagave running, so you
  can look around at the printed address; Ctrl-C stops and cleans up.
- `--keep` keeps the run folder (library, `api.log`, `worker.log`, the 2x
  PNGs) for a look afterwards.
- `SITESHOTS_CACHE=<folder>` keeps the MusicBrainz responses between runs.

The container and the run folder are removed at the end, on failure and on
Ctrl-C as well. Nothing else on the machine is touched.

To change the library, edit `albums.json`: use a MusicBrainz release ID
whose release has front art on the Cover Art Archive.
