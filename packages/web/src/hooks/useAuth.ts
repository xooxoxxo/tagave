/**
 * Authentication and session management hook. Sign-in and sign-out go
 * through Better Auth (/api/auth/*); the signed-in user comes from
 * GET /api/v1/auth/me, which reads the same session cookie.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { authClient, type AuthClientError } from '../services/authClient';
import { SessionUser, SetupRequest, LoginRequest } from '@liner/shared';

export const AUTH_QUERY_KEY = ['auth', 'me'];

export function useMe() {
  return useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: async () => {
      const response = await api.get<{ user: SessionUser }>('/auth/me');
      return response.user;
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: (failureCount, error: any) => {
      // Don't retry on 401 (not logged in)
      if (error?.status === 401) return false;
      return failureCount < 3;
    },
  });
}

export function useSetup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: SetupRequest) => api.post<{ user: SessionUser }>('/auth/setup', data),
    onSuccess: (data) => {
      queryClient.setQueryData(AUTH_QUERY_KEY, data.user);
    },
  });
}

/** Signed in, or one more step: the authenticator code (/login/2fa). */
export type SignInOutcome = { status: 'signed-in' } | { status: 'two-factor' };

/** Email + password through Better Auth (never the legacy /api/v1/auth/login). */
export async function signInWithPassword({ email, password }: LoginRequest): Promise<SignInOutcome> {
  const { data, error } = await authClient().signIn.email({ email, password });
  if (error) throw error;
  if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return { status: 'two-factor' };
  return { status: 'signed-in' };
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation<SignInOutcome, AuthClientError, LoginRequest>({
    mutationFn: signInWithPassword,
    onSuccess: async (outcome) => {
      if (outcome.status === 'signed-in') await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    },
  });
}

export async function signOut(): Promise<void> {
  await authClient().signOut();
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: AUTH_QUERY_KEY });
      window.location.href = '/login';
    },
  });
}
