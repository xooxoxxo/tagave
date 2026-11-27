/**
 * A tag plan's status chip, and what it means behind a "?" when the status
 * comes from an offline music folder (waiting for it, or paused by a split
 * it cut off). Any other status is the chip alone.
 */
import { Badge, HelpToggle } from './ui';
import type { PlanStatusView } from '../utils/planStatus';
import styles from './PlanStatusBadge.module.css';

export function PlanStatusBadge({ view }: { view: PlanStatusView }) {
  const badge = <Badge tone={view.tone}>{view.label}</Badge>;
  if (!view.help) return badge;
  return (
    // the "?" opens its hint on a line of its own; a click on it never opens the plan row
    <span className={styles.status} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {badge}
      <HelpToggle label={view.label}>{view.help}</HelpToggle>
    </span>
  );
}
