/**
 * First-run and system status queries.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import type { SystemCheck } from '../pages/setupWizard';

/**
 * true: no owner account yet. false: set up. An error (the API answers 503
 * when it cannot read its database) means "unknown", never "set up".
 */
export function useSetupRequired() {
  return useQuery({
    queryKey: ['auth', 'setup-required'],
    queryFn: () => api.get<{ setupRequired: boolean }>('/auth/setup-required').then((r) => r.setupRequired),
    retry: false,
    staleTime: 0,
  });
}

/**
 * The public health checks, for the wizard before any account exists.
 * /health answers 503 with the same body when the database or its schema is
 * down; those checks are what the owner needs to see, so they are returned
 * rather than thrown.
 */
export function useHealthChecks(enabled = true) {
  return useQuery({
    queryKey: ['system', 'health'],
    queryFn: async (): Promise<SystemCheck[]> => {
      try {
        const body = await api.get<{ checks?: SystemCheck[] }>('/health');
        return body.checks ?? [];
      } catch (err) {
        const body = err as { checks?: SystemCheck[] };
        if (Array.isArray(body.checks)) return body.checks;
        throw err;
      }
    },
    enabled,
    retry: false,
  });
}

export interface SystemChecksResponse {
  ok: boolean;
  checkedAt: string;
  checks: SystemCheck[];
}

/** The owner's view: every doctor check with a fix for each failure. */
export function useSystemChecks(
  opts: { refetchInterval?: number | false | ((data: SystemChecksResponse | undefined) => number | false) } = {},
) {
  const interval = opts.refetchInterval ?? false;
  return useQuery({
    queryKey: ['system', 'checks'],
    queryFn: () => api.get<SystemChecksResponse>('/system/checks'),
    refetchInterval: typeof interval === 'function' ? (q) => interval(q.state.data) : interval,
  });
}
