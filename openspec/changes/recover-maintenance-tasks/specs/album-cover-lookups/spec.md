## ADDED Requirements

### Requirement: Cover lookup has a visible outcome
Maintenance SHALL distinguish waiting, looking for art, no art found, and interrupted or failed. If the file worker is unavailable, Maintenance SHALL show that condition. Owners SHALL be able to retry an interrupted or failed lookup after the file worker returns.

#### Scenario: Cover lookup waits while the file worker is down
- **WHEN** a lookup is queued and no live file worker can claim it
- **THEN** Maintenance shows why it is waiting instead of leaving a spinner running indefinitely

#### Scenario: The lookup finishes with no art
- **WHEN** the lookup completes without a usable cover
- **THEN** Maintenance shows that no art was found and removes the busy status
