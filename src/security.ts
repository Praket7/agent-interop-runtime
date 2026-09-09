import path from 'node:path';
import fs from 'node:fs/promises';

export const blocked = /^(\.env($|\.)|id_(rsa|ed25519|ecdsa|dsa)$|credentials\.json$|.*\.(pem|key|p12|pfx)$)/i;

/** Keys whose string values must never survive sanitization. */
const SENSITIVE_KEYS = /token|secret|password|cookie|fingerprinthash|authorization|api[-_]?key|private[-_]?key|credential/i;

/**
 * Textual redaction (AI-11): replaces the complete credential value, not just the first token.
 * Covers `authorization: Bearer <value>` / `Basic <base64>`, `token=value` shapes, and known
 * credential formats in multiline diagnostics. Nonsensitive surrounding text remains readable.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) && (typeof v === 'string' || typeof v === 'number') ? '[REDACTED]' : redact(v)]));
  }
  return value;
}

const AUTH_HEADER = /((?:authorization|proxy-authorization)\s*[:=]\s*)(bearer|basic|token|digest)?\s*([^\s,;}"'`]+(?:\s+[^\s,;}"'`]+)*)/gi;
const KEY_VALUE = /((?:authToken|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|password|session[_-]?token|id[_-]?token|bearer)\s*["']?\s*[:=]\s*["']?)[^\s,"'`}\\]+/gi;
const OPENSSH_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function redactString(value: string): string {
  let out = value.replace(AUTH_HEADER, (_match, label: string, scheme: string | undefined, rest: string) => {
    // Keep the scheme (useful, nonsensitive) and remove the entire credential remainder.
    if (!scheme) return `${label}[REDACTED]`;
    // `rest` may contain the scheme plus credential; drop everything after the scheme.
    return `${label}${scheme} [REDACTED]`;
  });
  out = out.replace(KEY_VALUE, '$1[REDACTED]');
  out = out.replace(OPENSSH_KEY, '[REDACTED PRIVATE KEY]');
  return out;
}

export function sanitizeFreebuff(value: unknown): unknown {
  if (Array.isArray(value)) return value.flatMap((item) => { const clean = sanitizeFreebuff(item); return clean === undefined ? [] : [clean]; });
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'reasoning' || key === 'chainOfThought' || key === 'chain_of_thought' || key === 'metrics') continue;
      if (key === 'kind' && (item === 'reasoning' || item === 'tool' || item === 'ad')) return undefined;
      out[key] = sanitizeFreebuff(item);
    }
    return redact(out);
  }
  return value;
}

export function assertSafeId(id: string): string { if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw new Error('Invalid identifier'); return id; }

export async function safeProjectPath(root: string, requested: string): Promise<string> {
  const base = await fs.realpath(root);
  const candidate = await fs.realpath(path.resolve(base, requested));
  const rel = path.relative(base, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes the Freebuff project');
  const parts = rel.split(path.sep);
  if (parts.some((part) => blocked.test(part))) throw new Error('Protected file access denied');
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error('Only regular files may be read');
  return candidate;
}
