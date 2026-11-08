## ADDED Requirements

### Requirement: One durable record per maintenance task
Tagave SHALL save the task's intent and scope before dispatch. A repeated request for the same active operation and scope SHALL return the existing task.

#### Scenario: Request and dispatch are interrupted
- **WHEN** dispatch fails after Tagave saves the task
- **THEN** the task stays visible and can recover without starting duplicate work

### Requirement: Show progress and recovery actions
Tagave SHALL show the same task in Background activity and at its point of origin. It SHALL report waiting, running, interrupted, and final outcomes along with the current stage, progress when known, and any error. Retry SHALL start another attempt under the same task. Continue SHALL resume only from a checkpoint that the operation can verify.

#### Scenario: The owner returns after an interruption
- **WHEN** a worker stops mid-task and the owner reloads the page
- **THEN** both surfaces show the interruption and only offer recovery actions the task supports

#### Scenario: A duplicate worker attempts a file change
- **WHEN** an old attempt and a replacement attempt both try to advance the task
- **THEN** only the attempt that owns the current claim can change files or record progress
