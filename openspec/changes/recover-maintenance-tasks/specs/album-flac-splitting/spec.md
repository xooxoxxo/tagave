## ADDED Requirements

### Requirement: One-file FLAC analysis can recover
Tagave SHALL track analysis from both the Split sheet and Tag Plan. A request SHALL either show cut points for review or report why it stopped and how the owner can retry.

#### Scenario: An old analysis request never started
- **WHEN** an album or tag plan has an analyzing record with no live job
- **THEN** Tagave explains the interruption and allows a single retry once the file worker is available

### Requirement: Split recovery preserves the source and outputs
Tagave SHALL verify all staged tracks before moving the source to recoverable storage. Split and Tag Plan Apply SHALL save the source and output checkpoints needed to recover from a worker restart.

#### Scenario: The worker stops while publishing tracks
- **WHEN** the worker stops after publishing some or all tracks
- **THEN** Continue verifies the saved artifacts before completing or recovering the split, without overwriting unrelated files or creating duplicate tracks
