import type { FastifyRequest, FastifyReply } from 'fastify';
import type { SessionUser } from '@liner/shared/auth';

export interface RequestContext {
  user: SessionUser;
  libraryId?: string;
}

export type RouteHandler<T = any> = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<T>;
