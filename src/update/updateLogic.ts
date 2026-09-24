// Pure, dependency-free update logic. No vscode, no network — so it unit-tests cleanly.
// The vscode/network side (fetch manifest, download + install the .vsix, prompt reload) lives in
// UpdateChecker.ts, which builds on these helpers.

/** The release manifest the update server serves (e.g. Railway /latest.json). */
export interface UpdateManifest {
  /** The latest published version, e.g. "1.8.0" (a leading "v" is tolerated). */
  version: string;
  /** Absolute URL of the .vsix, or a path relative to the manifest URL. */
  vsixUrl: string;
  /** Optional human release notes shown in the "update available" prompt. */
  notes?: string;
  /** Optional SHA-256 (hex) of the .vsix. When present, the download is verified against it before
   *  install, so a tampered/corrupt package is refused instead of installed. */
  sha256?: string;
}

/** Normalize a manifest hash field to a lowercase 64-char hex SHA-256, or undefined if it isn't one. */
export function normalizeSha256(raw: unknown): string | undefined {
  if (typeof raw !== 'string') { return undefined; }
  const hex = raw.trim().toLowerCase().replace(/^sha256[:=]/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/**
 * Compare two dotted version strings numerically (semver-ish: major.minor.patch, extra segments and a
 * leading "v" tolerated). Returns 1 if a > b, -1 if a < b, 0 if equal. Non-numeric segments compare as 0,
 * so a malformed version never throws — it just sorts low, and the caller treats "not newer" as no update.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.trim().replace(/^v/i, '').split(/[.+-]/).map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) { return 1; }
    if (x < y) { return -1; }
  }
  return 0;
}

/** True when `latest` is a strictly newer version than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

/**
 * Validate and normalize an untrusted manifest payload into an UpdateManifest, or return undefined if it
 * isn't a usable release description. Accepts `vsixUrl` or `url` for the download field, and `notes` or
 * `releaseNotes` for the notes. Everything is treated as untrusted data — a bad shape never throws.
 */
export function parseManifest(raw: unknown): UpdateManifest | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === 'string' ? obj.version.trim() : '';
  const vsixUrl = typeof obj.vsixUrl === 'string' ? obj.vsixUrl.trim()
    : typeof obj.url === 'string' ? obj.url.trim() : '';
  // Anchored end-to-end: a version is digits-and-dots (with an optional leading v and optional -prerelease
  // tag) and NOTHING else. Without the `$` a value like "1.0.0/../evil" or "1.0.0; rm -rf" passed the check
  // and could then be interpolated into a vsix filename/path — anchoring closes that traversal/injection.
  if (!version || !/^v?\d+(\.\d+)*(-[0-9A-Za-z.]+)?$/.test(version)) { return undefined; }
  if (!vsixUrl) { return undefined; }
  const notes = typeof obj.notes === 'string' ? obj.notes
    : typeof obj.releaseNotes === 'string' ? obj.releaseNotes : undefined;
  const sha256 = normalizeSha256(obj.sha256 ?? obj.hash ?? obj.sha);
  // Only attach sha256 when present so a manifest without it stays exactly { version, vsixUrl, notes }.
  return sha256 ? { version: version.replace(/^v/i, ''), vsixUrl, notes, sha256 } : { version: version.replace(/^v/i, ''), vsixUrl, notes };
}

/**
 * Resolve the manifest's vsix field into an absolute https URL. Absolute http(s) URLs pass through
 * (http is upgraded to https); anything else is resolved relative to the manifest URL. Returns undefined
 * if it can't be made into an https URL — the caller then declines to auto-install rather than fetch junk.
 */
export function resolveVsixUrl(manifestUrl: string, vsixField: string): string | undefined {
  try {
    const resolved = new URL(vsixField, manifestUrl);
    if (resolved.protocol === 'http:') { resolved.protocol = 'https:'; }
    if (resolved.protocol !== 'https:') { return undefined; }
    return resolved.toString();
  } catch {
    return undefined;
  }
}
