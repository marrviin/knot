//! Personalization settings — server-owned preferences the display layer edits
//! over HTTP (same contract in local and remote mode). Two fields today, both
//! feeding the journal writer: the name the diary uses to address the user,
//! and the diary's SBTI personality (packages/shared/src/personality.ts).

import type { Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { OkResponse, PersonalizationBody, PersonalizationResponse } from '../schemas';
import { SBTI_TYPES } from '@journal/shared';
import { getSetting, setSetting, USER_DISPLAY_NAME, PARTNER_PERSONALITY } from '../store';

/** Sanity cap: a 称呼 is a name, not a sentence. */
const MAX_NAME_CHARS = 50;

/** Startup roll: the diary's SBTI persona is picked at random once and then
 *  stays fixed — this runs at server start (local mode = every app launch, but
 *  the persisted value wins after the first roll) and only assigns when unset. */
export function ensurePartnerPersonality(dataDir: string): void {
  if (getSetting(dataDir, PARTNER_PERSONALITY)) return;
  const picked = SBTI_TYPES[Math.floor(Math.random() * SBTI_TYPES.length)]!;
  setSetting(dataDir, PARTNER_PERSONALITY, picked.id);
  console.log(`[Journal server] personalization: 搭档性格随机抽中「${picked.name}」（${picked.code}）`);
}

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/settings/personalization',
    { schema: { response: { 200: PersonalizationResponse }, operationId: 'getPersonalization' } },
    async () => ({
      displayName: getSetting(app.cfg.dataDir, USER_DISPLAY_NAME) ?? '',
      personality: getSetting(app.cfg.dataDir, PARTNER_PERSONALITY) ?? '',
    }),
  );

  app.put<{ Body: Static<typeof PersonalizationBody> }>(
    '/settings/personalization',
    {
      schema: { body: PersonalizationBody, response: { 200: OkResponse }, operationId: 'savePersonalization' },
    },
    async (req) => {
      // personality 已被 ajv 限制进 SBTI 27 型 ∪ {''}，这里只需兜住称呼的长度。
      setSetting(
        app.cfg.dataDir,
        USER_DISPLAY_NAME,
        req.body.displayName.trim().slice(0, MAX_NAME_CHARS),
      );
      setSetting(app.cfg.dataDir, PARTNER_PERSONALITY, req.body.personality);
      return { ok: true };
    },
  );
}
