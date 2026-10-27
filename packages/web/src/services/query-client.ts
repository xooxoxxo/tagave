import { QueryClient } from '@tanstack/react-query';
import { shouldRetryQuery } from '../components/NotFound';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      // a 404 or 403 is the answer: show it now, not after three retries
      retry: shouldRetryQuery,
    },
  },
});
