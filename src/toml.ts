/**
 * Minimal TOML syntax validator (AI-09). Not a full TOML implementation: it verifies the
 * structural grammar the Codex config uses (tables, array-of-table headers, dotted and quoted
 * keys, strings, numbers, booleans, arrays, inline tables, comments) well enough to refuse
 * malformed input instead of editing it. Regex editing alone cannot honor that promise.
 */

export interface TomlIssue { line: number; message: string }

export function validateToml(text: string): TomlIssue[] {
  const issues: TomlIssue[] = [];
  const lines = text.split(/\r?\n/);
  let inMultilineString: '"""' | "'''" | null = null;
  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    if (inMultilineString) {
      const closer = rawLine.indexOf(inMultilineString);
      if (closer >= 0) inMultilineString = null;
      return;
    }
    const line = stripComment(rawLine);
    if (!line.trim()) return;
    if (/^\s*\[\[/.test(line)) { if (!/^\s*\[\[[^\]"]+\]\]\s*$/.test(line)) issues.push({ line: lineNumber, message: `Malformed array-of-table header: ${line.trim()}` }); return; }
    if (/^\s*\[/.test(line)) { if (!/^\s*\[[^\]"]+\]\s*$/.test(line)) issues.push({ line: lineNumber, message: `Malformed table header: ${line.trim()}` }); return; }
    if (!/^\s*[^=:#\s][^=]*=/.test(line)) { issues.push({ line: lineNumber, message: `Expected key = value, found: ${line.trim()}` }); return; }
    const valueStart = line.indexOf('=');
    const key = line.slice(0, valueStart).trim();
    if (!isValidKey(key)) issues.push({ line: lineNumber, message: `Invalid key: ${key}` });
    const value = line.slice(valueStart + 1).trim();
    const problem = validateValue(value);
    if (problem) issues.push({ line: lineNumber, message: problem });
    if (/^(\"\"\"|''')/.test(value)) {
      const delimiter = value.slice(0, 3) as '"""' | "'''";
      const remainder = value.slice(3);
      if (!remainder.includes(delimiter)) inMultilineString = delimiter;
    }
  });
  if (inMultilineString) issues.push({ line: lines.length, message: `Unterminated multiline string starting with ${inMultilineString}` });
  return issues;
}

function stripComment(line: string): string {
  let out = '';
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inString) { if (char === inString && line[i - 1] !== '\\') inString = null; out += char; continue; }
    if (char === '"' || char === "'") { inString = char; out += char; continue; }
    if (char === '#') break;
    out += char;
  }
  return out;
}

function isValidKey(key: string): boolean {
  return key.split('.').every((part) => {
    const trimmed = part.trim();
    if (!trimmed) return false;
    if (/^"[^"]*"$/.test(trimmed) || /^'[^']*'$/.test(trimmed)) return true;
    return /^[A-Za-z0-9_-]+$/.test(trimmed);
  });
}

function validateValue(value: string): string | undefined {
  if (!value) return 'Missing value';
  if (/^(\"\"\"|''')/.test(value)) return undefined; // multiline handled by caller
  if (/^("([^"\\\\]|\\\\.)*"|'[^']*')$/.test(value)) return undefined;
  if (/^(true|false)$/.test(value)) return undefined;
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(value)) return undefined;
  if (/^0x[0-9a-fA-F_]+$|^0o[0-7_]+$|^0b[01_]+$/.test(value)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(value)) return undefined;
  if (/^( inf|nan|\+inf|-inf)$/.test(value)) return undefined;
  if (value.startsWith('[')) return validateArray(value) === true ? undefined : `Malformed array: ${value.slice(0, 80)}`;
  if (value.startsWith('{')) return validateInlineTable(value) === true ? undefined : `Malformed inline table: ${value.slice(0, 80)}`;
  return `Unsupported or malformed value: ${value.slice(0, 80)}`;
}

function validateArray(value: string): boolean {
  const inner = value.trim();
  if (!inner.endsWith(']')) return false;
  let depth = 0; let inString: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (inString) { if (char === inString && inner[i - 1] !== '\\') inString = null; continue; }
    if (char === '"' || char === "'") { inString = char; continue; }
    if (char === '[') depth++;
    if (char === ']') { depth--; if (depth === 0) return i === inner.length - 1; }
    if (depth === 1 && char === ',') continue;
  }
  return depth === 0 && inString === null;
}

function validateInlineTable(value: string): boolean {
  const inner = value.trim();
  if (!inner.endsWith('}')) return false;
  let depth = 0; let inString: string | null = null;
  for (const char of inner) {
    if (inString) { if (char === inString) inString = null; continue; }
    if (char === '"' || char === "'") { inString = char; continue; }
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth > 1) return false;
  }
  return depth === 0 && inString === null;
}

/** Round-trip helper for tests: parse simple key/value lines under a table header. */
export function tomlTableValue(text: string, table: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[${table.replace(/\./g, '\\.')}]\\s*$`);
  let inside = false;
  for (const line of lines) {
    if (header.test(line)) { inside = true; continue; }
    if (inside && /^\s*\[/.test(line)) return undefined;
    if (inside) { const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`)); if (match?.[1]) return match[1]; }
  }
  return undefined;
}
