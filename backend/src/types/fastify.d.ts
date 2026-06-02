import { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      userId: number;
      email: string;
      is_admin?: boolean;
    };
    /** 由管理接口 verifyAdmin 注入 */
    adminUserId?: number;
  }
}