## ADDED Requirements

### Requirement: One upgrade task tracks a FLAC acquisition
Tagave SHALL offer Upgrade to FLAC for eligible owned albums that contain non-FLAC audio. The task SHALL track the Lidarr search, download, staging, verification, tagging, and replacement. After a restart it SHALL reconnect to the existing request before starting another search.

#### Scenario: An owner upgrades an eligible album
- **WHEN** the owner requests an upgrade with Lidarr configured for FLAC
- **THEN** one task shows the download and import progress and matches the staged files to that request

### Requirement: Replacement requires a verified complete edition
Tagave SHALL verify that the staged audio is FLAC and covers the expected edition, then tag it before replacing library files. It SHALL pause for review on an incomplete download, uncertain edition, or failed tag write.

#### Scenario: Lidarr imports the wrong edition or a partial album
- **WHEN** Tagave cannot verify the staged files against the expected edition
- **THEN** the task explains what needs review and leaves the original album available

### Requirement: Upgrade recovery protects the original
Tagave SHALL record the replacement checkpoints and keep the original recoverable in Trash once the catalog confirms the replacement.

#### Scenario: The worker stops during replacement
- **WHEN** the worker stops between staging the original and publishing or indexing the replacement
- **THEN** the task can continue the swap or restore the original without leaving a duplicate replacement
