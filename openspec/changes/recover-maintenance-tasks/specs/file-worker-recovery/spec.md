## ADDED Requirements

### Requirement: Detect a stalled file worker
Tagave SHALL report when the file worker misses its heartbeat. A healthy identify worker SHALL NOT satisfy file worker health. The stall warning SHALL reach the logs even if the file worker's main loop is blocked.

#### Scenario: File worker stops checking in
- **WHEN** the file worker exceeds its heartbeat deadline and the identify worker remains healthy
- **THEN** Tagave reports the file worker as unavailable and records a stall warning outside the blocked loop

### Requirement: Contain the workload that caused the stall
Tagave SHALL bound or isolate the file workload identified by the incident investigation so unrelated file jobs remain available.

#### Scenario: A scan encounters the stall trigger
- **WHEN** a scan encounters the reproduced workload
- **THEN** the scan yields, ends with a recorded reason, or runs in isolation while cover art, split analysis, and trash jobs can still start
