import { z } from 'zod';

export const ProblemDetailsSchema = z.object({
  type: z.string().url().optional(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z.record(z.array(z.string())).optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

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
      detail: this.detail,
      instance: this.instance,
    };
  }
}

export class ValidationError extends ApiError {
  constructor(detail: string, readonly errors?: Record<string, string[]>) {
    super(400, 'Validation Error', detail);
    this.name = 'ValidationError';
  }

  toJSON(): ProblemDetails {
    return {
      title: this.title,
      status: this.status,
      detail: this.detail,
      errors: this.errors,
    };
  }
}

export class AuthError extends ApiError {
  constructor(detail: string = 'Unauthorized') {
    super(401, 'Unauthorized', detail);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(detail: string = 'Forbidden') {
    super(403, 'Forbidden', detail);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(detail: string = 'Not Found') {
    super(404, 'Not Found', detail);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(detail: string = 'Conflict') {
    super(409, 'Conflict', detail);
    this.name = 'ConflictError';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
