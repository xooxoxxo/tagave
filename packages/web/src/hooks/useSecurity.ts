/**
 * Settings › Security data: GET /api/v1/auth/security, and revoking a
 * trusted device. Factor changes go through Better Auth's client.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import type { SecurityStatus } from '../pages/securityModel';

export const SECURITY_KEY = ['auth', 'security'] as const;

export function useSecurity() {
  return useQuery({ queryKey: SECURITY_KEY, queryFn: () => api.get<SecurityStatus>('/auth/security') });
}

export function useRefreshSecurity() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: SECURITY_KEY });
}

export function useForgetDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/auth/trusted-devices/${encodeURIComponent(id)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SECURITY_KEY }),
  });
}
