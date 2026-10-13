/** Runtime HTTP endpoint for the memory service: display-layer APIs call the
 *  server directly (this module configures the generated hey-api client) instead
 *  of round-tripping through IPC. Desktop bootstraps it via the memory_endpoint
 *  IPC (loopback child process + per-launch bearer token); the future web build
 *  reads a user-configured service URL from localStorage into the same entry.
 *
 *  window.knot stays available for desktop-only capabilities (pick_directory,
 *  MCP injection, watch rules, import events). */

import { client } from './client/client.gen';

export interface MemoryEndpoint {
  base: string;
  token: string | null;
}

/** Configured endpoint, null until bootstrap — callers surface the Chinese
 *  "memory service unavailable" message rather than firing requests into the
 *  void. */
let endpoint: MemoryEndpoint | null = null;

/** Point the generated client at a service instance. Idempotent; call once at
 *  renderer startup (desktop) or after the user saves connection settings (web).
 *  The interceptor adds the bearer header only when a token exists — local
 *  loopback mode runs without auth. */
export function setMemoryEndpoint(next: MemoryEndpoint): void {
  endpoint = next;
  client.setConfig({ baseUrl: next.base });
  client.interceptors.request.use((request) => {
    if (next.token) request.headers.set('Authorization', `Bearer ${next.token}`);
    return request;
  });
}

export function getMemoryEndpoint(): MemoryEndpoint | null {
  return endpoint;
}
