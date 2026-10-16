import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import type { ProblemDetails } from '@tagave/shared/problem';
import { PROBLEM_TYPES, createProblemDetails } from '@tagave/shared/problem';
import { databaseUnreachable } from '../lib/databaseUnreachable.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly instance?: string
  ) {
    super(detail || title);
    this.name = 'ApiError';
  }

  toJSON(): ProblemDetails {
    return {
      title: this.title,
      status: this.status,
      ...(this.detail && { detail: this.detail }),
      ...(this.instance && { instance: this.instance }),
    };
  }
}

export async function errorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler(async (error: Error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    // Log the error
    fastify.log.error(
      {
        err: error,
        statusCode: (error as any).statusCode || 500,
        url: request.url,
        method: request.method,
        requestId,
      },
      'Request error'
    );

    // Handle API errors
    if (error instanceof ApiError) {
      // a rate limit's refusal (lib/rateLimit.ts RateLimitError) says when to come back
      const retryAfterS = (error as { retryAfterS?: unknown }).retryAfterS;
      if (typeof retryAfterS === 'number') reply.header('retry-after', String(retryAfterS));
      return reply.status(error.status).send(error.toJSON());
    }

    // Handle Zod validation errors
    if (error instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of error.issues) {
        const path = issue.path.join('.');
        if (!fieldErrors[path]) {
          fieldErrors[path] = [];
        }
        fieldErrors[path].push(issue.message);
      }

      return reply.status(400).send({
        title: 'Validation Error',
        status: 400,
        detail: 'Request validation failed',
        ...(Object.keys(fieldErrors).length > 0 && { errors: fieldErrors }),
      });
    }

    // Handle generic errors
    const status = (error as any).statusCode || 500;

    // A 500 because the database is down (often the session lookup, before
    // any route): say so instead of "An unexpected error occurred".
    const down = status === 500 ? databaseUnreachable(error) : null;
    if (down) {
      return reply.status(503).send(
        createProblemDetails(503, 'Database unreachable', `The database cannot be reached: ${down}.`, PROBLEM_TYPES.databaseUnreachable, requestId)
      );
    }
    return reply.status(status).send(
      createProblemDetails(
        status,
        status === 500 ? 'Internal Server Error' : error.message,
        status === 500 ? 'An unexpected error occurred' : undefined,
        undefined,
        requestId
      )
    );
  });
}
