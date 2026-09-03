/**
 * Authentication and session management hook
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { SessionUser, SetupRequest, LoginRequest } from '@liner/shared';

const AUTH_QUERY_KEY = ['auth', 'me'];

export function useMe() {
  return useQuery({
    queryKey: AUTH_QUERY_KEY,
    queryFn: () => api.get<{ user: SessionUser }>('/auth/me'),
    select: (data) => data?.user,
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

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: LoginRequest) => api.post<{ user: SessionUser }>('/auth/login', data),
    onSuccess: (data) => {
      queryClient.setQueryData(AUTH_QUERY_KEY, data.user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: AUTH_QUERY_KEY });
      window.location.href = '/login';
    },
  });
}
