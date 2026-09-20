import { createHash } from 'node:crypto';

// Filenames that are secrets themselves (…/.env, …/id_rsa, …/server.pem). Kept broad but anchored on
// separators so ordinary code files (utils.ts, monkey.ts, keyboard.ts) are NOT swept up.
const SENSITIVE_NAME = /(^|[._-])(env|secret|secrets|credential|credentials|token|password|passwd|key|keys|apikey|pem|pfx|p12|keystore|jks|htpasswd)([._-]|$)/i;
// Whole-filename matches for well-known secret files that the name rule above wouldn't catch.
const SENSITIVE_FULL = /^(\.env(\..+)?|\.npmrc|\.pypirc|\.netrc|\.dockercfg|\.pgpass|id_[a-z0-9]+|.*\.(pem|pfx|p12|keystore|jks|asc|ppk))$/i;

// Secret VALUES to mask before any file/command output is sent to the provider. Each is a well-known
// credential shape (specific enough not to hit ordinary prose/code) rather than a broad "looks random"
// heuristic, so `const total = a + b;` is left untouched.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, // PEM private keys
  /\b(?:sk|api)[_-]?[a-z0-9]{12,}\b/gi,                       // generic sk-/api- keys (OpenAI-style)
  /\b(?:r|s)k_(?:live|test)_[0-9A-Za-z]{16,}\b/g,             // Stripe secret/restricted keys
  /\bAKIA[0-9A-Z]{16}\b/g,                                    // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g,                                    // AWS temporary access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                          // GitHub PAT / OAuth / server tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,                        // GitHub fine-grained PAT
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                               // Google API key
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,                        // Slack tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWTs
  /\bbearer\s+[a-z0-9._-]{12,}/gi,                            // Authorization: Bearer …
];

// A credential-bearing assignment (password/secret/token/api_key = "…"): mask only the quoted VALUE and
// keep the key name, so the model still sees the shape of the config without the literal secret. Requires
// quotes + a real assignment, so it won't fire on `password: userInput` (an unquoted identifier).
const ASSIGNED_SECRET = /((?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*)(["'])([^"'\n]{6,})\2/gi;

export function redact(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) { out = out.replace(pattern, '[REDACTED]'); }
  out = out.replace(ASSIGNED_SECRET, (_m, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`);
  return out;
}

export function isSensitivePath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').at(-1) ?? '';
  return SENSITIVE_NAME.test(name) || SENSITIVE_FULL.test(name);
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
