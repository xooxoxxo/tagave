/**
 * The Maintenance inspector in the app's bottom sheet: phones and tablets
 * (under 1024px), opened from the "To fix · 3" row under the album. Its own
 * chunk with the drawer; the page loads it on the first open.
 */
import type { RefObject } from 'react';
import { Sheet } from '../components/ui/Sheet';
import { MaintenanceInspector, type MaintenanceInspectorProps } from './MaintenanceInspector';
import styles from './MaintenanceSheet.module.css';

export interface MaintenanceSheetProps extends Omit<MaintenanceInspectorProps, 'variant'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: RefObject<HTMLElement | null> | undefined;
}

export function MaintenanceSheet({ open, onOpenChange, returnFocus, ...inspector }: MaintenanceSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Maintenance" side="bottom" returnFocus={returnFocus}>
      <div className={styles.pad}>
        <MaintenanceInspector variant="sheet" {...inspector} />
      </div>
    </Sheet>
  );
}
