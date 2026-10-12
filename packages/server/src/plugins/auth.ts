//! Bearer auth as an encapsulated plugin: the hook only guards routes
//! registered in the same scope, so /health (registered outside it in app.ts)
//! never needs a token — no URL-string matching like the old inline hook.

import type { FastifyInstance } from 'fastify';

export interface AuthOptions {
  token: string;
}

export default async function bearerAuth(app: FastifyInstance, opts: AuthOptions): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${opts.token}`) {
      // Body shape kept from the original inline hook: the desktop client
      // surfaces `message` as-is.
      return reply.code(401).send({ message: '未授权（token 不匹配）' });
    }
  });
}
