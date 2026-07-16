import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import type { FileJob } from '@nookeb/shared';

export interface AuthUser {
  userId: string;
  lineUserId: string;
  /** users.session_version the JWT carried — already verified current by
   *  `authenticate`. The vault unlock session binds to it (vault-session.service). */
  sessionVersion: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    supabase: SupabaseClient;
    r2: S3Client;
    redis: Redis;
    fileQueue: Queue<FileJob>;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    authUser: AuthUser | null;
    rawBody?: Buffer;
  }
}
