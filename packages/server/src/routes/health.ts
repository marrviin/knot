import type { FastifyInstance } from 'fastify';

import { embedSignatureOf } from '../config';
import { HealthResponse } from '../schemas';

/** /health is deliberately registered outside the bearer-auth scope (see
 *  app.ts): liveness must answer without a token — the desktop parent polls it
 *  before marking the child ready. */
export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { schema: { response: { 200: HealthResponse }, operationId: 'getHealth' } }, async () => {
    const ready = app.cfg.llm !== null;
    return {
      ok: true,
      ready,
      ...(app.cfg.llm
        ? { embedSignature: embedSignatureOf(app.cfg.llm), embedModel: app.cfg.llm.embedModel }
        : { notice: 'Embedding 未配置（缺少 KNOT_LLM_API_KEY）' }),
    };
  });
}
