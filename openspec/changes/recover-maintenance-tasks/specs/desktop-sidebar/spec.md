## ADDED Requirements

### Requirement: The desktop account row stays anchored
Tagave SHALL keep the account row anchored on desktop. Navigation SHALL scroll only when its contents need more room.

#### Scenario: The desktop sidebar fits
- **WHEN** the album page has enough space for the navigation and account row, including when the player is visible
- **THEN** the account row stays anchored and the sidebar has no unnecessary scroll

#### Scenario: A short or zoomed window needs scroll
- **WHEN** the navigation exceeds the space available or the account panel opens and closes
- **THEN** navigation and account controls remain reachable by keyboard without shifting the sidebar unnecessarily
