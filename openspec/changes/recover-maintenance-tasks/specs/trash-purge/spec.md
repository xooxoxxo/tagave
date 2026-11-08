## ADDED Requirements

### Requirement: Empty Trash acts on the confirmed selection
Tagave SHALL persist the exact file IDs confirmed by the owner. It SHALL dim the selected rows and prevent another Empty Trash request while the task is active. Restore and scheduled cleanup SHALL respect that task's file claims.

#### Scenario: New files enter Trash after confirmation
- **WHEN** the owner confirms a list and new files enter Trash before or during the purge
- **THEN** the purge touches only the confirmed files and the new entries remain visible and unselected

#### Scenario: A legacy request has no saved selection
- **WHEN** Tagave finds an older queued Empty Trash request without a confirmed file list
- **THEN** it requires fresh confirmation before deleting files for that request

### Requirement: A purge can stop and recover safely
Tagave SHALL report deleted, remaining, and failed files. Cancel SHALL stop before the next file starts. A continued purge SHALL recheck the correct music mount and use the original selection, skipping files already removed.

#### Scenario: The owner cancels a partial purge
- **WHEN** the owner cancels after some files have been deleted
- **THEN** the task shows what was deleted and leaves the remaining files in Trash

#### Scenario: The music mount is unavailable
- **WHEN** Tagave cannot confirm that the correct music mount is online
- **THEN** the task pauses without removing the files' catalog records or marking them deleted
