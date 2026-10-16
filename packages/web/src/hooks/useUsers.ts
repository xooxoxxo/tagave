/**
 * Settings › Users (owner) and the invite page: people, roles, one-time
 * invite and set-password links. The API asks for a fresh step-up on the
 * sensitive changes; useStepUpAction (SettingsUsersPage) handles that.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcceptInviteRequest, CreateInviteRequest, InviteLinkResponse, InviteLookup, PatchUserRequest,
  RemoveUserRequest, ResetSignInRequest, SessionUser, UsersOverview,
} from '@tagave/shared';
import { api } from '../services/api';
import { AUTH_QUERY_KEY } from './useAuth';
import { setCurrentRole } from './usePermissions';

export const USERS_KEY = ['users'] as const;

export function useUsers(enabled = true) {
  return useQuery({ queryKey: USERS_KEY, queryFn: () => api.get<UsersOverview>('/users'), enabled });
}

function useUsersMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }) });
}

export function useInviteUser() {
  return useUsersMutation((body: CreateInviteRequest) => api.post<InviteLinkResponse>('/users/invites', body));
}

export function useRevokeInvite() {
  return useUsersMutation((inviteId: string) => api.delete<void>(`/users/invites/${encodeURIComponent(inviteId)}`));
}

export function useChangeUser() {
  return useUsersMutation(({ userId, ...body }: PatchUserRequest & { userId: string }) => api.patch<void>(`/users/${encodeURIComponent(userId)}`, body));
}

export function useResetSignIn() {
  return useUsersMutation(({ userId, ...body }: Partial<ResetSignInRequest> & { userId: string }) =>
    api.post<InviteLinkResponse>(`/users/${encodeURIComponent(userId)}/reset-sign-in`, body));
}

export function useRemoveUser() {
  return useUsersMutation(({ userId, ...body }: RemoveUserRequest & { userId: string }) =>
    api.delete<void>(`/users/${encodeURIComponent(userId)}`, { body: JSON.stringify(body) }));
}

/** What an invite or set-password link is for (no session needed). */
export function useInviteLookup(token: string) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InviteLookup>(`/invites/${encodeURIComponent(token)}`),
    retry: false,
    staleTime: Infinity,
  });
}

/** Use the link: the account is made (or its password set) and this browser is signed in. */
export function useAcceptInvite(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AcceptInviteRequest) => api.post<{ user: SessionUser }>(`/invites/${encodeURIComponent(token)}/accept`, body),
    onSuccess: (data) => {
      setCurrentRole(data.user.role);
      queryClient.setQueryData(AUTH_QUERY_KEY, data.user);
    },
  });
}
