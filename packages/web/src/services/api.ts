/**
 * Typed API client for tagave backend.
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

/**
 * A success body, or undefined when there is none. DELETE answers 204 with
 * no body; calling response.json() on it threw "Unexpected end of JSON
 * input" after the plan was already gone, and the page showed that as the
 * delete failing.
 */
export async function readBody<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 205) return undefined as T;
  const text = await response.text();
  if (text.trim() === '') return undefined as T;
  return JSON.parse(text) as T;
}

class ApiClient {
  private baseUrl = '/api/v1';

  async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(options.headers);

    // Only claim a JSON body when there is one: Fastify answers 400
    // ("Body cannot be empty when content-type is set to 'application/json'")
    // to a bodiless POST/DELETE that still carries the header, which is what
    // every action button without a payload used to send.
    if (options.body != null && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include', // Include httpOnly cookies
    });

    // 401 is thrown as a typed error; routing decisions belong to the React
    // layer (App.tsx), never here — a hard redirect from the client caused an
    // infinite reload loop on /login.
    if (!response.ok) {
      const error: ApiError = await response.json().catch(() => ({
        status: response.status,
        title: response.statusText,
        type: `urn:problem:http:${response.status}`,
      }));
      error.status = response.status;
      throw error;
    }

    return readBody<T>(response);
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
