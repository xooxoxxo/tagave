Each checkbox is a reviewable change or a spike with written findings. A task can start once its named dependencies are complete.

## 1. Worker recovery and Lidarr staging

- [x] 1.1 Reproduce or narrow the November 7 file worker stall on disposable media. Record the evidence and a recovery procedure that accounts for queued Empty Trash requests.
- [x] 1.2 Make the watchdog report while the main loop is blocked. Show file worker health separately from identify worker health. Verify with a deliberately blocked loop.
- [x] 1.3 Bound or isolate the workload found in 1.1. Reproduce the stall and confirm cover art, split analysis, and trash jobs can still start.
- [x] 1.4 Test Lidarr staging in isolation. Record the FLAC profile, import status, path mapping, and behavior for an already monitored album.

## 2. Maintenance status

- [x] 2.1 Save task intent and scope before dispatch. Prevent duplicate active tasks and reconcile missing jobs or expired claims.
- [x] 2.2 Show task stages, progress, errors, and supported recovery actions in Background activity and the originating view. Verify that reload preserves the task. Depends on 2.1.
- [x] 2.3 Move cover art status to the task record. Distinguish waiting, looking, no art found, and interruption. Verify retry after worker recovery. Depends on 1.2 and 2.2.
- [x] 2.4 Fix desktop sidebar overflow. Check the account row and keyboard focus with the player visible, short windows, higher zoom, and the account panel open and closed.

## 3. One-file FLAC splitting

- [x] 3.1 Recover stalled split analysis from the Split sheet and Tag Plan. Show cut points or an actionable reason for failure. Check an old analyzing record whose job never started. Depends on 1.2 and 2.2.
- [x] 3.2 Checkpoint split writes and verify staged tracks before moving the source. Verify recovery before and after publication in both standalone Split and Tag Plan Apply. Depends on 3.1.

## 4. Missing albums and Empty Trash

- [x] 4.1 Put Get from Lidarr on eligible missing album cards and show request status after reload. Preserve the owner and configuration checks.
- [x] 4.2 Save the confirmed Empty Trash file IDs and show those rows and progress. Block duplicate requests and support cancellation between files. Verify restart, Restore, scheduled cleanup, an offline mount, and an old request with no saved selection. Depends on 2.2.

## 5. Upgrade to FLAC

- [x] 5.1 Add Upgrade to FLAC on eligible owned albums. Save one upgrade task and reconnect to the same Lidarr download after a restart. Depends on 1.4 and 2.2.
- [x] 5.2 Verify the staged files are FLAC and cover the expected edition, then tag them. Verify that a partial download, uncertain edition, or tag write failure pauses the task. Depends on 5.1.
- [x] 5.3 Publish the verified files, confirm the catalog update, and keep the original recoverable in Trash. Restart at each swap step and verify that Continue or recovery preserves one usable album. Depends on 5.2.
