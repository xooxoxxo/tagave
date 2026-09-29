/**
 * The API client on bodies: a 204 (DELETE) or an empty 200 is "done", not a
 * JSON parse error. Deleting a plan used to show "Failed to execute 'json'
 * on 'Response': Unexpected end of JSON input" after the plan was gone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, readBody } from './api';

const respond = (status: number, body: string | null, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(body, { status, headers }));

afterEach(() => vi.unstubAllGlobals());

describe('readBody', () => {
  it('reads nothing from a 204 and from an empty 200', async () => {
    expect(await readBody(new Response(null, { status: 204 }))).toBeUndefined();
    expect(await readBody(new Response('', { status: 200 }))).toBeUndefined();
    expect(await readBody(new Response('  \n', { status: 200 }))).toBeUndefined();
  });

  it('parses a JSON body', async () => {
    expect(await readBody(new Response('{"id":"p1","name":"x"}', { status: 200 }))).toEqual({ id: 'p1', name: 'x' });
  });
});

describe('api client', () => {
  it('resolves a DELETE answered with 204 and no body', async () => {
    const fetchMock = respond(204, null);
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.delete('/libraries/l/tag-plans/p')).resolves.toBeUndefined();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('DELETE');
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
  });

  it('throws the problem details of a refused DELETE', async () => {
    vi.stubGlobal('fetch', respond(409, JSON.stringify({ title: 'Conflict', detail: 'This plan wrote tags to 10 files' }), { 'content-type': 'application/problem+json' }));
    await expect(api.delete('/libraries/l/tag-plans/p')).rejects.toMatchObject({ status: 409, detail: 'This plan wrote tags to 10 files' });
  });

  it('sends a PATCH body as JSON', async () => {
    const fetchMock = respond(200, JSON.stringify({ id: 'p', name: 'New', nameByUser: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.patch('/libraries/l/tag-plans/p', { name: 'New' })).resolves.toEqual({ id: 'p', name: 'New', nameByUser: true });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe('{"name":"New"}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });
});
