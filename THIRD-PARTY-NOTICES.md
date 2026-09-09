# Third-party notices

The worker image ships the following third-party software.

## mutagen — GPL-2.0-or-later

The tag-writing sidecar (`packages/tagwriter-py`) depends on mutagen, which is
licensed GPL-2.0-or-later. Mutagen is invoked as a separate process over a JSON
protocol on standard input and output; it is not linked into this project's code.
Source: https://github.com/quodlibet/mutagen

## FFmpeg — LGPL-2.1-or-later / GPL-2.0-or-later depending on build

Used to slice cue-sheet images into per-track audio for fingerprinting, invoked as
a separate process. Source: https://ffmpeg.org

## Chromaprint / fpcalc — LGPL-2.1-or-later

Used to compute acoustic fingerprints, invoked as a separate process.
Source: https://github.com/acoustid/chromaprint
