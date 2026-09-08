# Third-Party Dependencies and Licensing

This document describes third-party software integrated into Liner with special licensing implications.

## Tag Writer

### mutagen (GPL-2.0-or-later)

**Status:** Active integration in tag writer pipeline (`packages/tagwriter-py/liner_tagwriter.py`)

**License:** GPL-2.0-or-later

**Usage:** Liner uses mutagen as the primary tag writing engine for reading and writing metadata tags in audio files (MP3, FLAC, M4A/ALAC, OGG, Opus, WAV, AIFF formats). The mutagen library is invoked as a Python sidecar process spawned by the worker.

**Personal use note:** Liner's tag-writing feature (scanning archives, reading canonical metadata from MusicBrainz/Discogs, writing to local files) is permitted for **personal, non-commercial use** under the GPL-2.0-or-later license. The GPL obligations (source availability, derivative work licensing) apply if Liner is distributed with or as part of a commercial service.

**Commercial tier guardrail (spike verdict):** If a future product tier offers commercial hosting, tag writing using mutagen **requires legal review before launch**. Licensing options include:
- Negotiating a commercial license with the mutagen maintainers
- Replacing mutagen with a permissively-licensed alternative (taglib, etc.)
- Licensing Liner's tag-writing feature as optional for commercial customers

Current deployment is personal/self-hosted only; this guardrail is a planning note for any commercial tier.

**Minimum version:** 1.47.0

### taglib-wasm (LGPL-2.1-or-later)

**Status:** Not currently used

**Note:** During M0 spike planning, taglib-wasm was evaluated for read-only tag parsing (format detection, existing tag inspection) as a web-friendly alternative. The verdict was to defer taglib-wasm adoption: mutagen's Python sidecar provides complete read-write coverage at lower integration cost. If a future M3+ task requires pure read-only tag inspection in the worker without mutagen, taglib-wasm can be re-evaluated. If integrated, it will be subject to LGPL-2.1-or-later obligations (linking notice, binary availability, source availability of modifications to the library itself).

---

**Last updated:** 2026-09-08
