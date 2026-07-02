import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import type { AuthUser } from '../types';

interface TokenPayload {
  sub: string; // users.id
  lineUserId: string;
}

export function signAppToken(payload: TokenPayload): string {
  return jwt.sign({ lineUserId: payload.lineUserId }, config.JWT_SECRET, {
    subject: payload.sub,
    expiresIn: '7d',
  });
}

export function verifyAppToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
    if (!decoded.sub || typeof decoded['lineUserId'] !== 'string') return null;
    return { userId: decoded.sub, lineUserId: decoded['lineUserId'] };
  } catch {
    return null;
  }
}

export default fp(async (app) => {
  app.decorateRequest('authUser', null);

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    // Fallback: ?token= for browser navigation (download redirects) that
    // cannot set an Authorization header.
    const queryToken = (request.query as Record<string, unknown> | undefined)?.['token'];
    const token = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : typeof queryToken === 'string'
        ? queryToken
        : null;

    const user = token ? verifyAppToken(token) : null;
    if (!user) {
      await reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    request.authUser = user;
  });
});
