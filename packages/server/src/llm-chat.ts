//! Minimal OpenAI-compatible chat completion client (fetch-based). Every
//! configured service (OpenAI, MiniMax, DeepSeek, …) speaks the standard
//! /chat/completions protocol; this serves Journal's own generation features
//! (journal writer) — mem0 keeps its own LLM instance for extraction.

import { withTimeout } from '@journal/shared';

import type { LlmConfig } from './config';

const CHAT_TIMEOUT_MS = 3 * 60_000;

/** One-shot completion. Reasoning models (M2.7/M3) may wrap the answer in
 *  <think> — stripped here, same as mem0's extractJson does. */
export async function chatCompletion(cfg: LlmConfig, system: string, user: string): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    }),
    CHAT_TIMEOUT_MS,
    '日志生成',
  );
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (data.choices?.[0]?.message?.content ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  if (!text) throw new Error('chat 返回空内容');
  return text;
}
