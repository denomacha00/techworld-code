import { createHash } from 'node:crypto';

const SENSITIVE_NAME = /(^|[._-])(env|secret|credential|token|password|key)([._-]|$)/i;
const SENSITIVE_VALUE = /((?:sk|api)[_-]?[a-z0-9]{12,}|bearer\s+[a-z0-9._-]{12,})/gi;

export function redact(value: string): string {
  return value.replace(SENSITIVE_VALUE, '[REDACTED]');
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_NAME.test(path.replace(/\\/g, '/').split('/').at(-1) ?? '');
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
