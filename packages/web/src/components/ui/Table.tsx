import { ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { Link } from '@tanstack/react-router';
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

export function TableRow({ to, onClick, className, children }: TableRowProps) {
  const cls = [styles.tr, className].filter(Boolean).join(' ');

  if (to) {
    return (
      <tr className={cls}>
        <td colSpan={999} style={{ padding: 0 }}>
          <Link to={to} className={styles.trLink}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                <tr>{children}</tr>
              </tbody>
            </table>
          </Link>
        </td>
      </tr>
    );
  }

  return (
    <tr className={cls} onClick={onClick} style={onClick ? { cursor: 'pointer' } : undefined}>
      {children}
    </tr>
  );
}
