//! Minimal TOML section editing for agents whose user-level config is TOML
//! (codex's ~/.codex/config.toml). Pure string in/out — a clean seam for tests
//! (same pattern as settings.ts taking the store as a parameter).
//! Deliberately not a full TOML parser: only whole `[mcp_servers.<key>]` tables
//! (bare or quoted key form) are ever stripped/appended, preserving the rest of
//! the document byte-for-byte.

/** Escape a server key for literal (bare or quoted) use inside a regex. */
function tomlKeyPattern(key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:${escaped}|"${escaped}")`;
}

/** Drop the whole `[mcp_servers.<key>]` table (bare or quoted key form) from a
 *  TOML document: from its header line to the next section header or EOF.
 *  Idempotent — a document without the section comes back unchanged. */
export function stripTomlSection(text: string, key: string): string {
  const header = new RegExp(
    `^\\s*\\[mcp_servers\\.${tomlKeyPattern(key)}\\]\\s*(#.*)?$`,
  );
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (header.test(line)) {
      skipping = true;
      continue;
    }
    // Any later section header (table or array-of-tables) ends the skip range.
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

export function hasTomlSection(text: string, key: string): boolean {
  return new RegExp(
    `^\\s*\\[mcp_servers\\.${tomlKeyPattern(key)}\\]`,
    "m",
  ).test(text);
}

/** Append a `[mcp_servers.<key>]` table (already-stripped document assumed):
 *  one blank line of separation after existing content, header + body lines,
 *  trailing newline. */
export function appendTomlSection(
  text: string,
  key: string,
  bodyLines: string[],
): string {
  const base = text.replace(/\n+$/, "");
  return (
    (base ? base + "\n\n" : "") +
    `[mcp_servers.${key}]\n` +
    bodyLines.join("\n") +
    "\n"
  );
}
