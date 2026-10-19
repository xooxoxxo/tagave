/**
 * What a person sees on a page their role does not include (a direct link
 * to Settings › Backups for a listener, say): a calm note and a way back,
 * never a broken page or a raw 403.
 */
import type { ReactNode } from 'react';
import { EmptyState, LinkButton, PageShell } from '../ui';

export interface NotAvailableProps {
  /** Inside a page that has its own heading (a Settings section): no page shell. */
  inline?: boolean;
  /** Who can help: defaults to the owner of this tagave. */
  text?: ReactNode;
}

export function NotAvailableContent({ text }: { text?: ReactNode }) {
  return (
    <EmptyState
      title="Not available for your account"
      text={text}
      action={<LinkButton to="/" variant="secondary">Go to Home</LinkButton>}
    />
  );
}

export function NotAvailable({ inline = false, text }: NotAvailableProps) {
  if (inline) return <NotAvailableContent text={text} />;
  return <PageShell title="Not available"><NotAvailableContent text={text} /></PageShell>;
}
