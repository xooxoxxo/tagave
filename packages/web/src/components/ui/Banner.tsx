import { ReactNode } from 'react';
import styles from './Banner.module.css';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

interface BannerProps {
  tone: BannerTone;
  children: ReactNode;
}

export function Banner({ tone, children }: BannerProps) {
  return (
    <div className={[styles.banner, styles[`tone-${tone}`]].join(' ')}>
      {children}
    </div>
  );
}
