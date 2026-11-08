## Why

When Tagave’s file worker froze during a scan, FLAC split analysis, cover art lookups, and Empty Trash all appeared to wait indefinitely. Owners need to see what happened and recover interrupted work, including when Tagave downloads and replaces an album with a verified FLAC copy.

## What Changes

- Detect when the file worker stops checking in and contain the workload that can block it.
- Show maintenance task progress on the page that started it and in Background activity. Recover interrupted work using saved task state.
- Give cover art lookups and one-file FLAC splits a way to recover from a stalled or lost job.
- Keep the desktop account row anchored while allowing navigation to scroll when it needs room.
- Put Get from Lidarr on eligible missing album cards. Add Upgrade to FLAC to eligible owned albums.
- Show what Empty Trash will delete, prevent duplicate requests, and let the owner cancel before the next file.

## Capabilities

### New Capabilities

This is Tagave’s first OpenSpec change. These are new spec entries for both existing and new behavior.

- `file-worker-recovery` covers file worker health, stall diagnosis, and containment.
- `maintenance-tasks` covers persistent task identity, progress, and recovery.
- `album-cover-lookups` covers cover art status and retry in Maintenance.
- `album-flac-splitting` covers analysis and recoverable writes for one-file FLAC albums.
- `desktop-sidebar` covers account row placement and navigation scrolling.
- `lidarr-missing-albums` covers visible requests and status on eligible missing album cards.
- `trash-purge` covers confirmed scope, progress, cancellation, and recovery for Empty Trash.
- `album-flac-upgrades` covers one task for downloading, verifying, tagging, and replacing an owned album.

### Modified Capabilities

There are no existing OpenSpec capability specs.

## Impact

This change affects Tagave’s API, web app, Postgres task data, pg-boss workers, and Lidarr intake. File writes and deletion remain on the worker that has the music mount. All seven requested features are in the first release. The worker diagnosis and the isolated Lidarr staging test come first so the implementation can use their findings.
