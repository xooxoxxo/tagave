/**
 * Typed API client for Liner backend.
 * Thin wrapper over fetch with support for:
 * - Automatic 401 → /login redirect (session expired)
 * - 404 on /auth/me with 401 → /setup redirect (no user yet)
 * - ProblemDetails error handling
 * - Credentials (httpOnly cookies)
 */

import { ProblemDetails } from '@liner/shared';

export interface ApiError extends ProblemDetails {
  status: number;
}

class ApiClient {
  private baseUrl = '/api/v1';

  async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(options.headers);

    if (!(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include', // Include httpOnly cookies
    });

    if (response.status === 401) {
      // Check if this is a /auth/me call - if so, might indicate no setup yet
      if (path === '/auth/me') {
        // Try to determine if setup is needed by checking if there's a library
        // For now, redirect to login and let the login page handle it
        window.location.href = '/login';
      } else {
        // Regular 401 - session expired
        window.location.href = '/login';
      }
      throw new Error('Redirecting to login');
    }

    if (!response.ok) {
      const error: ApiError = await response.json().catch(() => ({
        status: response.status,
        title: response.statusText,
        type: `urn:problem:http:${response.status}`,
      }));
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  get<T>(path: string, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, init?: RequestInit) {
    return this.request<T>(path, {
      ...init,
      method: 'POST',
      body: body ? JSON.stringify(body) : null,
    });
  }

  patch<T>(path: string, body?: unknown, init?: RequestInit) {
    return this.request<T>(path, {
      ...init,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : null,
    });
  }

  put<T>(path: string, body?: unknown, init?: RequestInit) {
    return this.request<T>(path, {
      ...init,
      method: 'PUT',
      body: body ? JSON.stringify(body) : null,
    });
  }

  delete<T>(path: string, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'DELETE' });
  }
}

export const api = new ApiClient();
