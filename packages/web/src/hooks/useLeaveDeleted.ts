import { useCallback } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { afterDelete } from '../utils/backNav';

/** Leave a page whose subject was just deleted: one step back, else `fallback` (utils/backNav afterDelete). */
export function useLeaveDeleted(): (fallback: string) => void {
  const router = useRouter();
  const navigate = useNavigate();
  return useCallback((fallback: string) => {
    const step = afterDelete(router.history.canGoBack(), fallback);
    if (step.kind === 'history') router.history.back();
    // replace: Back from there must not land on the deleted page
    else void navigate({ to: step.to as never, replace: true });
  }, [router, navigate]);
}
