# November 7 file worker stall

Production inspection was read-only. At 23:51 Amsterdam time a quick scan started. A DJ analysis job started at 23:52:14 and had no analysis row when pg-boss timed it out. The worker lost its heartbeat and kept using one CPU core. Two split requests and two cover lookups for the reported albums never started. The scan stayed active because the process could no longer advance its jobs.

The strongest lead is DJ analysis, which runs on the same event loop. An eight-second synthetic clip at 11,025 Hz reproduces a hang on the 0.27.0 code. It contains seven-sample tapered sine pulses 14,380 samples apart. The tempo estimator fitted a parabola to a descending shoulder and extrapolated a period of about −739 hops. The octave loop then kept doubling the negative period. A subprocess running the unmodified analyzer timed out after three seconds. Production had no CPU stack capture, so this reproduces a failure in the implicated workload without proving that the original track hit the same branch.

## Safe recovery for an affected install

1. Inspect the file worker's heartbeat, logs, and queue before restarting it. Save the scan and DJ job timestamps for diagnosis.
2. Inspect every waiting `files.trash` job and distinguish `empty`, `move`, and `sweep`. This install had one of each. A legacy `empty` request can select files that arrived after confirmation, so hold it for fresh confirmation before recovering the worker. Review whether the move and retention sweep should also run.
3. After the queue has been reviewed, start the corrected worker with the same music mount and database. Confirm that the file worker checks in and claims a read-only job, such as split analysis or a cover lookup.
4. Check the interrupted scan and verify its next run completes. Review pending trash operations with their exact scope before letting them continue.

## Regression cases

- Given a tracked scan, when the main thread is blocked, the stall warning appears before it resumes and identifies the scan.
- Given an identify-only heartbeat, when the system checks worker health, it shows that the identify worker is available and the file worker is unavailable.
- Given the synthetic DJ clip, when the analyzer estimates tempo, it finishes with no reliable tempo. An unrelated file job can still start.

The fixed analyzer returned with no reliable tempo. A disposable Postgres run then claimed work on `art.fetch`, `files.split`, and `files.trash` from the same event loop. The watchdog test also received a warning before the blocked main thread resumed, with the scan's queue and job ID.
