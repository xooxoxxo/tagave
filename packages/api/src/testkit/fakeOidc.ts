/**
 * A small OpenID Connect provider for the login-service suites: discovery,
 * keys, the token endpoint (checks the client, redirect URI and PKCE S256)
 * and userinfo. The browser step is `authorize()`: the test reads the
 * authorization URL tagave made and picks who signs in.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUser {
  sub: string;
  email?: string;
  name?: string;
  groups?: string[];
  emailVerified?: boolean;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string | null;
  nonce: string | null;
  user: FakeUser;
  authTime: number;
  claims: Record<string, unknown>;
}

export interface AuthorizeOptions {
  /** Seconds since the epoch the person signed in at (default now). */
  authTime?: number;
  /** Extra or replaced id_token claims (e.g. another iss or nonce). */
  claims?: Record<string, unknown>;
}

export class FakeOidc {
  issuer = '';
  readonly clientId = 'tagave-test';
  readonly clientSecret = 'fake-client-secret-0123456789';
  /** Every authorization URL's query, in order. */
  readonly requests: URLSearchParams[] = [];
  /** Token-endpoint calls whose PKCE check failed. */
  pkceFailures = 0;
  /** Make discovery name another issuer. */
  discoveryIssuer: string | null = null;
  private server: Server | undefined;
  private readonly key: KeyObject;
  private readonly jwk: Record<string, unknown>;
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, FakeUser>();

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey;
    this.jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'RS256', use: 'sig' };
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** The browser step: `user` signs in at the authorization URL; returns tagave's callback URL. */
  authorize(authorizationUrl: string, user: FakeUser, opts: AuthorizeOptions = {}): string {
    const url = new URL(authorizationUrl);
    const q = url.searchParams;
    this.requests.push(q);
    if (q.get('client_id') !== this.clientId) throw new Error('unknown client');
    if (q.get('response_type') !== 'code') throw new Error('not the code flow');
    const code = randomBytes(16).toString('hex');
    this.grants.set(code, {
      clientId: this.clientId,
      redirectUri: q.get('redirect_uri')!,
      challenge: q.get('code_challenge_method') === 'S256' ? q.get('code_challenge') : null,
      nonce: q.get('nonce'),
      user,
      authTime: opts.authTime ?? Math.floor(Date.now() / 1000),
      claims: opts.claims ?? {},
    });
    const back = new URL(q.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state')!);
    return back.toString();
  }

  private idToken(g: Grant): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.issuer,
      aud: this.clientId,
      sub: g.user.sub,
      iat: now,
      exp: now + 300,
      auth_time: g.authTime,
      ...(g.nonce ? { nonce: g.nonce } : {}),
      ...(g.user.email ? { email: g.user.email, email_verified: g.user.emailVerified ?? true } : {}),
      ...(g.user.name ? { name: g.user.name } : {}),
      ...(g.user.groups ? { groups: g.user.groups } : {}),
      ...g.claims,
    };
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), this.key).toString('base64url');
    return `${head}.${body}.${sig}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: this.discoveryIssuer ?? this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile', 'groups'],
      });
    }
    if (url.pathname === '/jwks') return send(200, { keys: [this.jwk] });
    if (url.pathname === '/userinfo') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const user = this.accessTokens.get(token);
      if (!user) return send(401, { error: 'invalid_token' });
      return send(200, { sub: user.sub, email: user.email, name: user.name, groups: user.groups });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent)
        : null;
      const clientId = basic?.[0] ?? form.get('client_id');
      const secret = basic?.[1] ?? form.get('client_secret');
      if (clientId !== this.clientId || secret !== this.clientSecret) return send(401, { error: 'invalid_client' });
      const code = form.get('code') ?? '';
      const g = this.grants.get(code);
      this.grants.delete(code);
      if (!g || form.get('grant_type') !== 'authorization_code') return send(400, { error: 'invalid_grant' });
      if (form.get('redirect_uri') !== g.redirectUri) return send(400, { error: 'invalid_grant' });
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!g.challenge || challenge !== g.challenge) {
        this.pkceFailures++;
        return send(400, { error: 'invalid_grant', error_description: 'PKCE' });
      }
      const access = randomBytes(16).toString('hex');
      this.accessTokens.set(access, g.user);
      return send(200, { access_token: access, token_type: 'Bearer', expires_in: 300, id_token: this.idToken(g), refresh_token: 'fake-refresh' });
    }
    send(404, { error: 'not_found' });
  }
}
