import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { hash, verify } from 'argon2';
import { uuidv7 } from 'uuidv7';
import type { SQL } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { makeDb, users, libraries } from '@liner/db';
import { setupRequestSchema, loginRequestSchema, sessionUserSchema } from '@liner/shared/auth';
import { ApiError } from '../middleware/errorHandler.js';
import { createSession, invalidateSession } from '../middleware/auth.js';

function isSecureConnection(request: FastifyRequest): boolean {
  return (
    request.protocol === 'https' ||
    request.headers['x-forwarded-proto']?.includes('https') === true
  );
}

export async function createAuthRoutes(fastify: FastifyInstance) {
  // Setup endpoint (first-run account creation)
  fastify.post('/setup', async (request: FastifyRequest, reply: FastifyReply) => {
    // Check if HTTPS or ALLOW_INSECURE_HTTP
    if (!isSecureConnection(request) && process.env.ALLOW_INSECURE_HTTP !== 'true') {
      throw new ApiError(
        400,
        'Insecure Connection',
        'Setup requires HTTPS. Set ALLOW_INSECURE_HTTP=true to allow HTTP in development.',
        '/api/v1/auth/setup'
      );
    }

    // Validate request
    const body = setupRequestSchema.parse(request.body);

    const { db } = await makeDb(process.env.DATABASE_URL!);

    // Check if user already exists
    const existingUsers = await db.select().from(users);
    if (existingUsers.length > 0) {
      throw new ApiError(409, 'Conflict', 'An owner account already exists', '/api/v1/auth/setup');
    }

    // Hash password
    const passwordHash = await hash(body.password);

    // Create user
    const userId = uuidv7();
    const user = {
      id: userId,
      email: body.email,
      displayName: body.displayName,
      passwordHash,
      role: 'owner' as const,
      createdAt: new Date(),
    };

    await db.insert(users).values(user);

    // Create default library
    const libraryId = uuidv7();
    const library = {
      id: libraryId,
      ownerUserId: userId,
      name: 'My Music Library',
      settings: JSON.stringify({
        contactString: body.contactString,
      }),
      createdAt: new Date(),
    };

    await db.insert(libraries).values(library);

    // Create session
    const sessionUser = sessionUserSchema.parse({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: new Date().toISOString(),
    });

    const sessionId = await createSession(userId);

    reply
      .setCookie('sessionId', sessionId, {
        httpOnly: true,
        secure: isSecureConnection(request),
        sameSite: 'strict',
        path: '/',
        maxAge: 30 * 24 * 60 * 60, // 30 days
      })
      .status(201)
      .send({ user: sessionUser });
  });

  // Login endpoint
  fastify.post('/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = loginRequestSchema.parse(request.body);

    const { db } = await makeDb(process.env.DATABASE_URL!);

    // Find user
    const userRecords = await db.select().from(users).where(eq(users.email, body.email));

    if (userRecords.length === 0) {
      throw new ApiError(401, 'Unauthorized', 'Invalid email or password', '/api/v1/auth/login');
    }

    const user = userRecords[0];
    if (!user) {
      // Invariant: this should never happen since we checked userRecords.length > 0 above
      throw new ApiError(401, 'Unauthorized', 'Invalid email or password', '/api/v1/auth/login');
    }

    // Verify password
    const passwordMatch = await verify(user.passwordHash, body.password);
    if (!passwordMatch) {
      throw new ApiError(401, 'Unauthorized', 'Invalid email or password', '/api/v1/auth/login');
    }

    // Create session
    const sessionUser = sessionUserSchema.parse({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: new Date().toISOString(),
    });

    const sessionId = await createSession(user.id);

    reply
      .setCookie('sessionId', sessionId, {
        httpOnly: true,
        secure: isSecureConnection(request),
        sameSite: 'strict',
        path: '/',
        maxAge: 30 * 24 * 60 * 60,
      })
      .status(200)
      .send({ user: sessionUser });
  });

  // Logout endpoint
  fastify.post('/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionCookie = request.cookies.sessionId;

    if (sessionCookie) {
      await invalidateSession(sessionCookie);
    }

    reply.clearCookie('sessionId', { path: '/' }).status(200).send({ success: true });
  });

  // Get current user endpoint
  fastify.get('/me', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new ApiError(401, 'Unauthorized', 'Authentication required', '/api/v1/auth/me');
    }

    reply.status(200).send({ user: request.user });
  });
}
