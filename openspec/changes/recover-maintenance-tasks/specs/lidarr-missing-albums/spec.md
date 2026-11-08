## ADDED Requirements

### Requirement: Get from Lidarr is visible on eligible missing albums
Tagave SHALL show Get from Lidarr directly on eligible missing album cards for owners with Lidarr configured. The card SHALL show the current request status after reload.

#### Scenario: The owner views an eligible missing album
- **WHEN** the album is missing and has the IDs Lidarr needs
- **THEN** the owner can request it from the card without opening the overflow menu

#### Scenario: A request already exists
- **WHEN** the owner returns to a card for an album already requested
- **THEN** the card shows the request state and the available next action
