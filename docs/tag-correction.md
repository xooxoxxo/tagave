# Tag correction

tagave safely corrects tags in your music files using a canonical schema derived from MusicBrainz and Discogs metadata. The tag-correction workflow is journaled and fully revertible, with built-in safeguards against accidental data loss.

## Canonical schema and field mapping

Tag correction covers the essential MusicBrainz fields for every album. The canonical schema defines a normalized set of fields and how they map to different container formats:

- **Identifiers:** `musicbrainz_albumid`, `musicbrainz_releasegroupid`, `musicbrainz_albumartistid`, `musicbrainz_artistid`
- **Album metadata:** `album`, `albumartist`, `albumartistsort`, `date`, `originaldate`, `releasestatus`, `releasetype`, `releasecountry`
- **Track data:** `title`, `artist`, `artistsort`, `tracknumber`, `totaltracks`, `discnumber`, `totaldiscs`, `discsubtitle`
- **Classification:** `genre`, `compilation`, `media`, `label`, `catalognumber`, `barcode`, `isrc`

The canonical schema ensures consistent field names across MP3, FLAC, M4A/ALAC, OGG, Opus, WAV, and AIFF. Each format has different native tag names and conventions, but the canonical schema presents one unified interface.

## Read/write policies

Each file is tagged according to a read/write policy you define. Policies control how changes are applied:

- **Overwrite mode:** replace all canonical fields with new values
- **Fill blanks mode:** only write fields that are empty in the original
- **Custom per-field rules:** mix strategies (e.g., overwrite MusicBrainz IDs, fill blanks for titles, never touch ratings)

Policies respect **field locks**, album-level rules that preserve your custom values across all rewrites.

## The three-phase workflow: Preview → Apply → Revert

Tag correction is always safe because writes go through a strict workflow:

1. **Preview:** Analyze files without writing. Compute per-file diffs (field name, old value, new value, reason) and validate that the policy respects locks, format limits, and guardrails. Export the diff table before committing to anything.

2. **Apply:** Write changes through the tag writer. An audio-hash is computed before and after the write. If the audio-hash doesn't match, the file is marked failed and the job pauses. A hash mismatch is treated as a defect that requires investigation, never as a retriable error. Hashes are stored in the audit log for every write.

3. **Revert:** Build a new plan from the audit journal to restore old values. Preview the revert diffs, then apply them the same way.

All three phases respect the same guardrails.

## Format-specific guardrails

tagave enforces safe write limits for each container format:

- **APE / WavPack:** read-only in v1. tagave reads existing APE tags but does not write them. These container formats require additional validation and testing before write support is added.
- **Cue-image albums:** write only album-level fields to the image file. The cue-image album-level rule forbids writing track titles, track numbers, or splitting the audio file when the album is sourced from a CUE sheet.

**Concurrency and resource limits:**

- Writes proceed at concurrency 2 to respect NFS mount I/O limits.
- A free-space precheck on the mount prevents partial writes if storage runs out.
- Temporary files are written next to the original (same filesystem) for atomic rename.

## Audit and locking

Every tag change is logged in the audit trail:

- **History tab** on any album shows match history, decisions, tag writes, and revert points.
- **Field locks:** lock a field on an album to keep your custom value. The lock survives reverts and is respected by future policies.
