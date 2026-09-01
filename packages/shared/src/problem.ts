import { z } from 'zod';

/**
 * RFC 9457 Problem Details for HTTP APIs
 * https://datatracker.ietf.org/doc/html/rfc9457
 */
export const problemDetailsSchema = z.object({
  type: z.string().url().optional().describe('A URI reference that identifies the problem type'),
  title: z.string().describe('A short, human-readable summary of the problem type'),
  status: z.number().int().min(100).max(599).describe('The HTTP status code'),
  detail: z.string().optional().describe('A human-readable explanation specific to this occurrence'),
  instance: z.string().url().optional().describe('A URI reference that identifies the specific occurrence'),
}).strict();

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

/**
 * Common HTTP error status codes used in Liner
 */
export enum HttpStatusCode {
  OK = 200,
  Created = 201,
  Accepted = 202,
  NoContent = 204,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  Conflict = 409,
  Gone = 410,
  UnprocessableEntity = 422,
  TooManyRequests = 429,
  InternalServerError = 500,
  ServiceUnavailable = 503,
}

/**
 * Helper to create a ProblemDetails response
 */
export function createProblemDetails(
  status: HttpStatusCode,
  title: string,
  detail?: string,
  type?: string,
  instance?: string,
): ProblemDetails {
  return {
    status,
    title,
    ...(detail && { detail }),
    ...(type && { type }),
    ...(instance && { instance }),
  };
}
