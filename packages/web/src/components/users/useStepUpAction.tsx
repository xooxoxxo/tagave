/**
 * Run a sensitive action; when the API answers "Step-up required", ask the
 * person to confirm it is them (StepUpDialog) and run it again.
 *
 *   const { run, dialog } = useStepUpAction();
 *   await run('Invite deniz@example.com', () => invite.mutateAsync(body));
 *   return <>{…}{dialog}</>;
 */
import { useCallback, useState, type ReactNode } from 'react';
import type { StepUpMethod } from '@tagave/shared';
import { StepUpDialog } from '../StepUpDialog';
import { getStepUp } from '../../services/stepUp';

interface Pending {
  action: string;
  methods: StepUpMethod[];
  done: () => void;
  cancel: () => void;
}

export function isStepUpRequired(err: unknown): boolean {
  const e = err as { status?: number; title?: string } | null;
  return e?.status === 403 && e.title === 'Step-up required';
}

export function useStepUpAction(): { run: <T>(action: string, fn: () => Promise<T>) => Promise<T | undefined>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);

  const run = useCallback(async <T,>(action: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      if (!isStepUpRequired(err)) throw err;
      const status = await getStepUp();
      const confirmed = await new Promise<boolean>((resolve) => {
        setPending({ action, methods: status.methods, done: () => resolve(true), cancel: () => resolve(false) });
      });
      setPending(null);
      return confirmed ? fn() : undefined;
    }
  }, []);

  const dialog = pending ? (
    <StepUpDialog action={pending.action} methods={pending.methods} onDone={pending.done} onCancel={pending.cancel} />
  ) : null;
  return { run, dialog };
}
