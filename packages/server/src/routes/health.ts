import type { FastifyInstance } from 'fastify';

import { embedSignatureOf } from '../config';
import { HealthResponse } from '../schemas';

/** /health is deliberately registered outside the bearer-auth scope (see
 *  app.ts): liveness must answer without a token — the desktop parent polls it
 *  before marking the child ready. */
export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { schema: { response: { 200: HealthResponse }, operationId: 'getHealth' } }, async () => {
    // Embeddings always run locally, so the service is always ready; the chat
    // key inside only enables journal backfill.
    const llm = app.cfg.llm;
    return {
      ok: true,
      ready: true,
      embedSignature: embedSignatureOf(llm),
      embedModel: llm.embedModel,
    };
  });
}
