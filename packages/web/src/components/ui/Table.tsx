import { ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { useNavigate } from '@tanstack/react-router';
import styles from './Table.module.css';

export function Table({
  className,
  children,
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className={styles.tableWrapper}>
      <table className={[styles.table, className].filter(Boolean).join(' ')} {...props}>
        {children}
      </table>
    </div>
  );
}

export function Th({
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={[styles.th, className].filter(Boolean).join(' ')} {...props} />
  );
}

export function Td({
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={[styles.td, className].filter(Boolean).join(' ')} {...props} />
  );
}

interface TableRowProps {
  to?: string;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}

/**
 * A row that navigates. Cells stay in the parent table (a nested table for
 * the link broke column alignment against the header), so the row itself is
 * the link: click or Enter / Space navigates, and it is focusable.
 */
export function TableRow({ to, onClick, className, children }: TableRowProps) {
  const navigate = useNavigate();
  const go = to ? () => { void navigate({ to }); } : onClick;
  const cls = [styles.tr, go ? styles.trClickable : '', className].filter(Boolean).join(' ');
  if (!go) return <tr className={cls}>{children}</tr>;
  return (
    <tr
      className={cls}
      onClick={go}
      tabIndex={0}
      role="link"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      }}
    >
      {children}
    </tr>
  );
}
