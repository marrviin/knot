//! Minimal YAML mapping editing for agents whose user-level config is YAML
//! (hermes's ~/.hermes/config.yaml: `mcp_servers.<name>` entries). Pure string
//! in/out — a clean seam for tests (same pattern as toml-section.ts).
//! Deliberately not a YAML parse/dump round-trip: that would reflow the user's
//! config and destroy comments. Only whole top-level `<rootKey>:` mapping
//! entries are stripped/appended, block-style, line by line — everything else
//! is preserved byte-for-byte. Flow-style values ({} / inline maps) throw so a
//! config we can't reason about is never mangled.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Line matching `key:` (bare or quoted) at exactly `indent` spaces, with any
 *  inline value — the entry key itself, not a deeper-nested duplicate. */
function keyLineRe(indent: number, key: string): RegExp {
  const k = escapeRe(key);
  return new RegExp(`^ {${indent}}(?:"${k}"|'${k}'|${k}):(?:\\s.*)?$`);
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "";

/**
 * Insert or replace the `key:` entry under the top-level `rootKey:` mapping.
 * `entryLines` are written indented one level under the entry key. Returns the
 * updated document; comments and formatting outside the replaced entry are kept.
 */
export function upsertYamlMappingEntry(
  text: string,
  rootKey: string,
  key: string,
  entryLines: string[],
): string {
  const lines = text.split("\n");
  const rootRe = new RegExp(`^${escapeRe(rootKey)}:(?:\\s*(?:#.*)?)?$`);
  const rootIdx = lines.findIndex((l) => rootRe.test(l));

  if (rootIdx === -1) {
    if (new RegExp(`^${escapeRe(rootKey)}:\\s*[^#\\s]`).test(text)) {
      // Flow-style / non-mapping value: not something line editing may touch.
      throw new Error(
        `无法自动编辑 ${rootKey} 配置（不是块状映射），请手动添加 journal 条目`,
      );
    }
    // Root mapping absent: append it (fresh file → no leading blank line).
    const base = text.replace(/\n+$/, "");
    const block = [
      `${rootKey}:`,
      ...entry("  ", key, entryLines),
    ];
    return (base ? base + "\n\n" : "") + block.join("\n") + "\n";
  }

  // Root mapping's value block: from the line after the root key to the first
  // non-blank line back at indent 0 (the next top-level key) or EOF. The entry
  // indent is taken from the first non-blank child line (null until then — 2 is
  // a perfectly valid real indent and must not read as "unset").
  let blockEnd = lines.length;
  let childIndent: number | null = null;
  for (let j = rootIdx + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (isBlank(l)) continue;
    if (indentOf(l) === 0) {
      blockEnd = j;
      break;
    }
    if (childIndent === null || indentOf(l) < childIndent) childIndent = indentOf(l);
  }
  childIndent ??= 2;

  const entryRe = keyLineRe(childIndent, key);
  const entryIdx = lines.findIndex(
    (l, i) => i > rootIdx && i < blockEnd && entryRe.test(l),
  );

  if (entryIdx !== -1) {
    // Replace: drop the old entry (its key line to the next line at or above
    // the entry's indent, or the block end) and splice ours in its place.
    let entryEnd = blockEnd;
    for (let m = entryIdx + 1; m < blockEnd; m++) {
      const l = lines[m]!;
      if (!isBlank(l) && indentOf(l) <= childIndent) {
        entryEnd = m;
        break;
      }
    }
    lines.splice(entryIdx, entryEnd - entryIdx, ...entry(" ".repeat(childIndent), key, entryLines));
    return lines.join("\n");
  }

  // New entry: insert at the block end; when the block runs to EOF, drop the
  // trailing blank lines first so the entry doesn't land after them.
  let at = blockEnd;
  if (at === lines.length) {
    while (at > rootIdx + 1 && isBlank(lines[at - 1]!)) at--;
  }
  lines.splice(at, 0, ...entry(" ".repeat(childIndent), key, entryLines));
  const out = lines.join("\n");
  // Trailing blanks trimmed above also removed the input's final newline — put
  // it back so a re-edit of the file sees the same shape.
  return text.endsWith("\n") && !out.endsWith("\n") ? out + "\n" : out;
}

function entry(indent: string, key: string, entryLines: string[]): string[] {
  return [`${indent}${key}:`, ...entryLines.map((l) => `${indent}  ${l}`)];
}

/** Drop the `key:` entry (key line + deeper-indented children) from the
 *  top-level `rootKey:` mapping. Returns the document unchanged when the
 *  entry (or the root mapping) is absent. */
export function removeYamlMappingEntry(
  text: string,
  rootKey: string,
  key: string,
): string {
  const lines = text.split("\n");
  const rootIdx = lines.findIndex((l) =>
    new RegExp(`^${escapeRe(rootKey)}:(?:\\s*(?:#.*)?)?$`).test(l),
  );
  if (rootIdx === -1) return text;
  let blockEnd = lines.length;
  let childIndent: number | null = null;
  for (let j = rootIdx + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (isBlank(l)) continue;
    if (indentOf(l) === 0) {
      blockEnd = j;
      break;
    }
    if (childIndent === null || indentOf(l) < childIndent) childIndent = indentOf(l);
  }
  if (childIndent === null) return text;
  const entryRe = keyLineRe(childIndent, key);
  const entryIdx = lines.findIndex((l, i) => i > rootIdx && i < blockEnd && entryRe.test(l));
  if (entryIdx === -1) return text;
  let entryEnd = blockEnd;
  for (let m = entryIdx + 1; m < blockEnd; m++) {
    const l = lines[m]!;
    if (!isBlank(l) && indentOf(l) <= childIndent) {
      entryEnd = m;
      break;
    }
  }
  lines.splice(entryIdx, entryEnd - entryIdx);
  const out = lines.join("\n");
  // Removing the block-final entry can swallow the input's trailing newline —
  // put it back so the document shape stays stable.
  return text.endsWith("\n") && !out.endsWith("\n") ? out + "\n" : out;
}

/** True when the top-level `rootKey:` mapping holds a `key:` entry. */
export function hasYamlMappingEntry(
  text: string,
  rootKey: string,
  key: string,
): boolean {
  const lines = text.split("\n");
  const rootIdx = lines.findIndex((l) =>
    new RegExp(`^${escapeRe(rootKey)}:(?:\\s*(?:#.*)?)?$`).test(l),
  );
  if (rootIdx === -1) return false;
  let childIndent: number | null = null;
  for (let j = rootIdx + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (isBlank(l)) continue;
    if (indentOf(l) === 0) break;
    if (childIndent === null || indentOf(l) < childIndent) childIndent = indentOf(l);
  }
  if (childIndent === null) return false;
  const entryRe = keyLineRe(childIndent, key);
  return lines.some((l, i) => i > rootIdx && entryRe.test(l) && indentOf(l) === childIndent);
}
