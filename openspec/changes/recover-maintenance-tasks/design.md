## Context

On Tagave 0.27.0, the file worker stopped checking in during a quick scan on November 7, 2026. Its main thread was still using nearly a full CPU core when inspected. Postgres showed two split requests and two cover art lookups without a start time. Empty Trash was also queued. The production check was read-only. An unbounded DJ tempo loop reproduced the stall in isolation. The exact production stack was unavailable.

The split API saves an analyzing row before sending the job. Cover art status reads the latest pg-boss job directly. Empty Trash selects eligible files when the worker runs, even if they arrived after confirmation. Background activity already has progress updates, but its generic Cancel route only changes the display state. [Split route](../../../packages/api/src/routes/albumSplits.ts) · [Cover art status](../../../packages/api/src/lib/artFetchState.ts) · [Trash worker](../../../packages/worker/src/lib/deletions.ts) · [Job controls](../../../packages/api/src/routes/jobs.ts)

## Goals / Non-Goals

Make the approved maintenance workflows visible and recoverable after a reload or worker restart. Keep the first release focused on split, cover art, sidebar, missing album requests, task recovery, Empty Trash, and FLAC upgrades. Local format conversion and a general rewrite of all background jobs are outside this change.

## Decisions

### Keep pg-boss and save task state in Tagave

Use Postgres for task identity, intent, scope, attempts, checkpoints, and final outcomes. Use pg-boss for dispatch. Persist intent before dispatch and reconcile tasks whose jobs were lost or whose claims expired. Use operation scope and a database constraint to prevent two active tasks for the same work. A claim must be checked at each safe boundary. Before another attempt mutates files, confirm the old attempt cannot still do so.

Reuse Background activity and its progress updates. The album or Trash view reads the same record. Retry creates a new attempt, while Continue checks the operation's saved state and existing files. The task record is the source for manual cover lookup status. The generic display-only controls must not back the new task actions. Keep existing callers working while each workflow moves to the new contract.

### Diagnose and contain the file worker stall

Use a file worker health signal that knows which queues the worker actually serves. The watchdog needs a log path that works while the main thread is frozen. A local test showed that worker-thread `stderr` can wait for the blocked thread. A test that blocks that thread must prove the new path works. Reproduce the November stall on disposable media before deciding whether to bound the work, yield, or isolate it. [Watchdog](../../../packages/worker/src/lib/watchdog.ts) · [Worker registration](../../../packages/worker/src/index.ts)

### Checkpoint file changes at the point of execution

Save the split source and staged output paths before publishing. Verify that the on-disk artifacts belong to the task before resuming, cleaning up, or finishing a split. Use the same recovery path from the album and Tag Plan Apply. Keep the existing review of cut points and write permission checks. [Split worker](../../../packages/worker/src/jobs/filesSplit.ts) · [Tag Plan Apply](../../../packages/worker/src/jobs/tagsApply.ts)

For Empty Trash, save the file IDs the owner confirmed. Claim those entries atomically against Restore and scheduled cleanup. Check the correct mount before deleting and distinguish a confirmed missing file from a permission or I/O error. Save intent and outcome per file so a restart between unlink and the database update can reconcile that file safely. A cancellation check precedes each unlink. If a file is already being deleted, finish recording its outcome before stopping.

### Stage Lidarr upgrades away from the library copy

Reuse Lidarr settings, path mapping, and the drop pool where the isolated test confirms they fit. Save the upgrade intent before contacting Lidarr. Match the downloaded files to the request before accepting them. The existing missing album poll considers an already owned release complete, so an upgrade needs its own completion rule. [Lidarr worker](../../../packages/worker/src/jobs/lidarr.ts) · [Lidarr API](https://lidarr.audio/docs/api/)

Verify the FLAC codec and complete edition before tagging. Stage the verified replacement and journal the swap. Keep the original in task-owned recovery storage until the catalog confirms the replacement, then make it available in Trash. An existing Lidarr artist must already use the mapped drop pool and a FLAC-only profile. Tagave keeps the artist’s settings. Files that were already imported before the request do not count as the new download. If a swap stops before catalog confirmation, the owner can restore the original from the task.

The current manual Replace path can move the old album before proving that the new tracks match. Use its matching and tagging pieces without that ordering. [Pool import](../../../packages/worker/src/jobs/poolImport.ts)

### Keep independent UI fixes small

Put Get from Lidarr on eligible missing album cards, using the existing owner and configuration checks. Keep the account row anchored and let the navigation area scroll when it exceeds its space. Verify desktop layout with the player visible, the account panel open and closed, and at short or zoomed viewports. [Lidarr controls](../../../packages/web/src/components/LidarrControls.tsx) · [Sidebar layout](../../../packages/web/src/components/Layout.module.css)

## Risks / Trade-offs

- A retry may run while an earlier process still holds a file operation. Verify ownership and reconcile artifacts before another attempt writes.
- A mount failure can look like a missing file. Require mount validation before treating an absent trash file as deleted.
- Lidarr may retain prior monitoring, quality, or path settings. The staging test must prove that a request cannot overwrite the library copy.
- A long-running job can appear healthy if only the container is checked. Treat worker heartbeats and actual queue registration as the service signal.

## Migration Plan

Add task storage and read support before migrating workflows. Reconcile old split records against live jobs without creating duplicate attempts. A queued legacy Empty Trash request has no confirmed list. Block it from deleting files and require fresh confirmation before it can become a tracked purge.

Keep recovery records through deployment and rollback. Before rolling back a build that understands task checkpoints, settle or preserve active file operations so older workers cannot replay them without their safeguards. Verify on a disposable library by restarting the worker before and after file writes.

## Open Questions

- A DJ analysis job timed out during the stall. Task 1.1 reproduced an unbounded loop in that workload on synthetic audio. See the [incident notes](worker-incident.md) for the evidence and recovery procedure.
- Task 1.4 verified the [Lidarr staging contract](lidarr-staging.md) with an isolated fixture. Real download validation needs an install with a configured indexer.

## Task storage regression cases

- Given two concurrent requests for the same scope, saving and dispatching them yields one task and one job.
- Given a dispatch error, the task still has its intent and can dispatch the same attempt later.
- Given an expired job, the task becomes interrupted. A newer attempt cannot claim the scope while the old worker still holds it.
