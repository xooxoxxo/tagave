# Deployment and Operations Guide

## Worker Architecture

Liner uses a multi-process worker architecture to separate concerns and scale independently. This guide covers deployment patterns and operational requirements, especially for tag correction (M2+).

### File Worker

The **file worker** (`~/liner-worker.sh` launch script) handles all tasks that require direct file system access to your music library:

- **Scanning:** discovering files, computing audio hashes, clustering by container signature
- **Clustered cover art:** analyzing images, fetching from APIs, embedding thumbnails
- **Recomputing gaps:** detecting incomplete albums or formatting issues
- **Tag correction:** previewing tag changes, applying metadata writes, reverting tags from journal

All file worker jobs are claimed from queues named in `LINER_QUEUES`:

```sh
LINER_QUEUES=scan.root,scan.parse,cluster.dir,art.fetch,art.sweep,gaps.recompute,queue.autoaccept,tags.preview,tags.apply,tags.revert
```

The file worker must:
1. Be deployed **on the host that mounts the music library**
2. Have the library mounted **writable** at a consistent path (e.g., `/mnt/music` or `/music`)
3. Have **Python 3.x on PATH** (minimum 3.8; tested with 3.13) — required for the tag writer sidecar

### NFS Mount Writeability

Tag correction (XO-314, XO-315, XO-359) requires the music library mount to be **writable**. If your library is an NFS export:

**Before deployment:** Ensure the NFS mount is configured `rw` (read-write):

```sh
# On the host mounting the NFS export
mount | grep /mnt/music
# Example output: 192.168.x.x:/volume1/music on /mnt/music type nfs4 (rw,relatime,...)
```

If the mount shows `ro` (read-only), remount it writable:

```sh
sudo mount -o remount,rw /mnt/music
```

Or edit `/etc/fstab` and remount:

```
192.168.x.x:/volume1/music /mnt/music nfs4 defaults,rw 0 0
```

Then reload:

```sh
sudo systemctl daemon-reload
sudo mount -a
```

**In Liner settings:** Register the scan root with `writable = true` (Settings › Scan roots › [root] › Properties › Writable). The worker probes the NFS mount on startup; if the probe fails, tag-correction jobs will be paused with a warning.

### Identify Worker

The **identify worker** handles external API calls (MusicBrainz, Discogs, Wikidata, Wikipedia). It can run on any host with internet access and does not need access to the music files:

```sh
LINER_QUEUES=identify.album,identify.sweep,enrich.release,enrich.sweep,reviews.fetch,artists.resolve,artists.enrich
node packages/worker/dist/index.js
```

## Tag Correction Deployment

When deploying M2 (tag correction), the file worker becomes critical. Tag jobs are queued in the same pg-boss queue system as all other jobs and respect the `QUEUE_POLICIES` defined in `packages/worker/src/index.ts`.

### Queue Configuration

Three new queues are added for tag correction:

- **`tags.preview`:** Analyze files against a tag policy; compute per-field diffs without writing
- **`tags.apply`:** Write tag changes to files using the mutagen Python sidecar; update `audio_files` records and create audit entries
- **`tags.revert`:** Build a revert plan from the audit journal and preview or apply reverted tags (see XO-314 owner rule)

All three queues use `stately` policy (single concurrent job, paused on failure) per the M2 build order §4 guardrails.

Example `QUEUE_POLICIES` entry (in `packages/worker/src/index.ts`):

```typescript
'tags.preview': { concurrency: 1, policy: 'stately' },
'tags.apply': { concurrency: 1, policy: 'stately' },
'tags.revert': { concurrency: 1, policy: 'stately' },
```

### Cue-Image Rule (XO-314)

Liner handles **cue-image albums** (multi-track virtual albums sourced from a single file with a cue sheet) with special handling during tag writes. The rule is:

**Write only album-level fields to the image file; never write track titles, track numbers, or split the file.**

Examples of album-level fields (safe to write): `album`, `albumartist`, `date`, `genre`, `label`.

Examples of track-level fields (never written to cue-image files): `title`, `tracknumber`, `totaltracks`, `artist` (track-specific).

This guardrail is enforced in the preview and apply jobs before writing. Tag plans targeting cue-image albums will skip track-level field changes with a reason in the diff.

### Python Dependency

The tag writer sidecar (`packages/tagwriter-py/liner_tagwriter.py`) requires Python 3.8+ with mutagen installed. On the file worker host:

```sh
python3 --version          # Verify 3.8+
python3 -m pip install mutagen>=1.47.0
```

Or, if a virtual environment is used (recommended for isolation):

```sh
cd packages/tagwriter-py
python3 -m venv .venv
.venv/bin/pip install mutagen>=1.47.0
export LINER_TAGWRITER_PYTHON=/path/to/.venv/bin/python3
```

The worker will locate the Python interpreter in this order:
1. `LINER_TAGWRITER_PYTHON` environment variable
2. `.venv/bin/python3` in `packages/tagwriter-py` (if venv is set up locally)
3. `python3` on PATH (system-wide)

## Deployment Workflow

### Fresh deployment (both workers)

1. **Set up the file worker host:**
   - Mount the music library (writable for tag correction)
   - Install Node.js, pnpm, Python 3.8+, and mutagen
   - Clone the repo: `git clone https://github.com/oytuneyucel/liner.git`
   - Build: `pnpm install && pnpm -r build`

2. **Customize environment:**
   ```sh
   export DATABASE_URL=postgres://liner:password@db-host:5432/liner
   export APP_SECRET=<32-byte hex value>
   export LINER_QUEUES=scan.root,scan.parse,cluster.dir,art.fetch,art.sweep,gaps.recompute,queue.autoaccept,tags.preview,tags.apply,tags.revert
   ```

3. **Launch the file worker:**
   ```sh
   node packages/worker/dist/index.js
   ```
   (See `scripts/deploy.sh` for a production launcher that tracks the PID and handles restarts.)

4. **In a separate process, launch the identify worker:**
   ```sh
   export LINER_QUEUES=identify.album,identify.sweep,enrich.release,enrich.sweep,reviews.fetch,artists.resolve,artists.enrich
   node packages/worker/dist/index.js
   ```

5. **Run the app:**
   - On the app host: `docker compose up -d` (or `node packages/api/dist/index.js` in development)
   - Visit `http://localhost:3100` and complete setup

### Upgrading

After deploying code changes:

```sh
# Pull updates
git pull

# Rebuild packages (incrementally)
pnpm install
pnpm -r build

# Run migrations
node packages/db/dist/migrations-lib.js

# Restart workers (graceful shutdown on SIGTERM)
pkill -TERM -f "packages/worker/dist/index.js"
sleep 5
node packages/worker/dist/index.js
```

The app can stay running during a worker restart; jobs queued while a worker is down will be claimed when the worker restarts.

## Health Checks

To verify workers are connected and healthy:

```sh
curl http://localhost:3100/api/v1/health
```

Example output:
```json
{
  "ok": true,
  "status": "2 live worker(s) detected",
  "checks": {
    "database": { "ok": true },
    "workers": { "ok": true, "count": 2 },
    "queues": { "ok": true }
  }
}
```

Run the full diagnostic:

```sh
node packages/doctor/dist/cli.js doctor
```

This checks:
- Database connection and migrations
- Worker heartbeats
- Scan root configuration and writeability probe
- Provider credentials (MusicBrainz, Discogs)
- Disk space and Python availability

## Monitoring

### Logs

- **App:** `docker logs <app_container>` or stdout if running bare
- **Workers:** stdout (recommend redirecting to a file or systemd journal)
- **Database:** check Postgres logs in the `pgdata` volume

### Database Auditing

Tag writes create entries in the `audit_log` table:

```sql
SELECT id, user_id, action, resource_type, resource_id, details, created_at
FROM audit_log
WHERE action LIKE 'tag%'
ORDER BY created_at DESC
LIMIT 50;
```

Tag plan state and item diffs are stored in `tag_plans` and `tag_plan_items`:

```sql
SELECT id, library_id, scope, policy, status, created_at
FROM tag_plans
ORDER BY created_at DESC
LIMIT 10;
```

---

**Last updated:** 2026-09-08

**Related tickets:** XO-309 (identify worker hardening), XO-314 (cue-image rule), XO-316 (queue policies), XO-359 (this document)
