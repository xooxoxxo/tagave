# Production recovery verification

This is an execution runbook, not evidence of a completed production recovery. Keep the original November 7 split and cover requests as the acceptance cases. A fresh smoke-test album does not demonstrate that those requests recovered. Merge, release, deployment, and any additional production mutation require the owner's approved Hook scope.

## Release and installation route

The last production inspection reported standard Compose 0.27.0. Reconfirm the installation folder and containers before acting; substitute the verified SSH host and file-worker container name:

```sh
ssh COMPOSE_HOST 'docker ps -a --format "{{.Names}} {{.Image}} {{.Status}}"'
ssh COMPOSE_HOST 'docker inspect FILE_WORKER_CONTAINER --format "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}"'
```

Run the remaining host commands in that verified installation folder, using its existing Compose configuration. Do not print `.env`, container environments, or credentials.

The release route is `scripts/release.sh X.Y.Z` on clean `main`: first invocation drafts notes and bumps the root version; edit the notes, then invoke it again to commit and tag. It does not push. After the approved push, `.github/workflows/ci.yml` builds images and publishes a tagged release only after attaching the signed manifest. Main builds `edge`; a green PR or main build alone is not an installable signed release. Wait for the tag's `release-manifest` job and published release before updating production.

Use `install-tagave.sh update --version X.Y.Z` for this recovery, following [operations](../../../docs/operations.md). The installer backs up, updates the pinned release, stops workers, migrates through the new app, and starts new workers. Unlike the in-app updater, its failure path prints rollback instructions instead of automatically starting the old build. The in-app updater's automatic rollback can restart an old file worker against the queued legacy Empty Trash request; do not use that route for this incident unless that request has first been safely quarantined under separate authorization.

Local `.deploy.env` describes an older source topology with separate app and worker hosts. It is unverified for the current install. Do not run `scripts/deploy.sh` against it. If source deployment is separately confirmed, stop old consumers first: `scripts/deploy.sh all` otherwise deploys the app before stopping old workers.

## Capture the original requests (read-only)

Before updating, save the UTC timestamp, image identities, worker log excerpt, heartbeat rows, and original job/split IDs. On the Compose host:

```sh
date -u
docker compose ps -a
docker compose logs --since '2026-11-07T22:45:00Z' --tail 300 worker-files

docker compose exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN READ ONLY;
SELECT worker_id, seen_at, now() - seen_at AS age,
       info->>'version' AS version, info->>'sha' AS sha,
       info->'queues' AS queues, info->'loopLagMs' AS loop_lag_ms
FROM worker_heartbeats ORDER BY seen_at DESC;

SELECT id, name, state, created_on, started_on, completed_on,
       data->>'libraryId' AS library_id,
       data->>'localAlbumId' AS album_id,
       data->>'splitId' AS split_id,
       data->>'action' AS action, data ? 'maintenance' AS tracked
FROM pgboss.job
WHERE name IN ('files.split', 'art.fetch', 'files.trash', 'dj.analyze', 'scan.root')
  AND (state IN ('created', 'retry', 'active')
       OR created_on >= timestamptz '2026-11-07 22:45:00+00')
ORDER BY created_on;

SELECT id, library_id, local_album_id, state, plan IS NOT NULL AS has_plan,
       outputs, error, created_at, updated_at, finished_at
FROM album_splits
WHERE state IN ('analyzing', 'splitting', 'failed')
   OR created_at >= timestamptz '2026-11-07 22:45:00+00'
ORDER BY created_at;
COMMIT;
SQL
```

Match the two original split and two cover requests to the owner's reported albums, using the album IDs and original timestamps. Record all four IDs and each split's `splitId`; do not assume every recent queued job belongs to the incident. If old pg-boss jobs have expired out of retention, retain the saved evidence and identify the same albums/split rows before replay. Logs or job rows may already be gone; record that limit explicitly.

Inspect **all** pending `files.trash` rows, not just `action=empty`. The incident had `empty`, `move`, and `sweep`; absent action also takes the sweep path. Their behavior differs: the new worker skips an untracked `empty`, while move and retention sweep can still change files. Resolve their disposition in the deployment approval before enabling consumers. An HTTP 200 health response alone does not prove a live file worker.

## Contain old consumers, then update (authorized mutations)

1. With approval covering the outage and queued work, stop every worker that can consume `files.trash` **before** any restart or update. On the verified single-host Compose install, run `docker compose stop worker-identify worker-files`, then `docker compose ps -a`. Confirm both are stopped. Inspect any other worker processes/hosts identified in the baseline; a stale/missing heartbeat does not prove a hung process is gone. Split installs require stopping the remote file worker too.
2. Keep old consumers stopped. Do not restart 0.27.0 to test whether the stall clears. The new `filesTrashJob` guard rejects `action=empty` without `maintenance`; it cannot protect work claimed by an old process. Do not alter pg-boss rows ad hoc. If the queued move/sweep cannot be allowed to run, stop here and obtain a concrete queue-containment procedure before enabling the file worker.
3. Use the installed script's `./install-tagave.sh update --version X.Y.Z --dry-run`, then the approved `./install-tagave.sh update --version X.Y.Z --yes`. Verify the pre-update backup exists and the update completes. Keep the same library mounts and cache volumes.
4. If the update fails, leave old workers stopped. Do not follow a blanket rollback `docker compose up -d`: an old consumer could run the legacy Empty Trash request. Recovery/rollback must preserve task checkpoints and contain destructive jobs before any old build starts.
5. Confirm the new file worker logs `worker ready`; rerun the heartbeat query twice at least 30 seconds apart. `seen_at` must advance and the build must match the approved release/commit. The file role must serve `art.fetch` and `files.split` (explicitly, through `*`, or through `tags.apply` for `files.split`). An identify-only worker is insufficient. Check `/api/v1/version` and `/api/v1/health`, including `workerRoles`, against this evidence.

## Verify originals and replay only if needed

Re-run the queue and split queries using the captured IDs as filters. Watch `docker compose logs --since <deployment-UTC-time> worker-files` for `files.split start`, its original `jobId`/`splitId`, errors, and any stall warnings. For cover jobs, use queue timestamps and the originating album's status; a per-job cover start log is not guaranteed.

- **Still queued/active:** let the original job advance. Do not create a competing replay. A legacy split with a live pg-boss job deliberately remains associated with that job. If it stays active without progress, collect logs/heartbeat and investigate rather than changing its state manually.
- **Split analysis terminal or lost:** open the original album's Split sheet or Tag Plan. It must offer an actionable stopped state, not an endless spinner. If no live original analysis remains, use Retry analysis. The API is `POST /api/v1/libraries/:libraryId/albums/:albumId/split`; it preserves an eligible existing analysis row and serializes duplicate requests. For a tracked task, use its offered `retry`/`continue` action at `POST /api/v1/libraries/:libraryId/maintenance-tasks/:taskId/:action`. Use the authenticated UI; no credentials belong in this runbook.
- **Cover lookup terminal or lost:** after the original job is no longer live, retry from the same album's Maintenance view. Its API is `POST /api/v1/libraries/:libraryId/albums/:albumId/fetch-art`; tracked tasks also expose their supported recovery actions. A lookup can write cover cache/catalog data and contact providers, so this replay must be in the approved recovery scope.
- **No music writes as a verification shortcut:** analysis success means the same split reaches `ready` with cut points. Do not press Split, apply a Tag Plan, or call `/:splitId/run` merely to verify analysis. A specific failure reason is evidence the queue recovered, but does not count as a successful split-analysis result.

After migration, inspect durable recovery state with the same read-only psql wrapper:

```sql
BEGIN READ ONLY;
SELECT id, library_id, kind, subject_id, scope_key, state, stage, attempt,
       attempt_id, error, updated_at
FROM maintenance_tasks
WHERE kind IN ('cover', 'split', 'empty-trash')
ORDER BY updated_at DESC LIMIT 50;
COMMIT;
```

Record the original-to-replay relationship (album ID, original job ID, split ID, task ID, attempt ID), terminal result and UTC time. Cover success is a found cover or explicit “No cover art found”; provider failure must remain actionable. Confirm the same state after reloading the album and Background activity. Legacy requests that complete without a new task can be proven by their queue row and split/album state; do not invent a migrated task.

For the legacy Empty Trash request, expect the new-worker warning `Ignored legacy Empty Trash job without a confirmed selection` and no purge attributable to that request. It may be marked completed because it was safely skipped; completion alone does not mean deletion. Never reconfirm Empty Trash as a smoke test. Review any actual purge separately against a fresh exact selection.

Completion evidence must show both original albums' cut-point results, both original cover results, advancing file-worker heartbeats while those jobs run, and safe disposition of the legacy Empty Trash request. Record unresolved jobs, unavailable retained evidence, or failed analysis/provider results as blockers rather than claiming full recovery.
