// Techword Code talks ONLY to your own Cloudflare Worker proxy (proxy/worker.js), which forwards
// to the real upstream server-side. So the extension bundle and all network traffic show only YOUR
// domain — the upstream host is never present client-side and cannot be discovered by inspecting
// the extension or watching requests. The upstream lives solely in worker.js, which does not ship.
// (The shipped bundle is also string-encrypted by the obfuscation pass, so even this URL isn't
// greppable in the .vsix — but it's your own domain, so exposure would be harmless anyway.)
export const TECHWORD_API_BASE_URL = 'https://techword-api.g9137347.workers.dev';
export const TECHWORD_PROVIDER_ID = 'techword-api';
export const TECHWORD_API_KEY_SECRET = 'techwordCode.techwordApiKey';

/**
 * Curated catalog of models Techword Code knows how to label nicely.
 * This is only a display catalog: the real list shown to a user is whatever
 * the Techword API reports at connect time (see ProviderRegistry.resolveModels).
 * If the API returns nothing, we fall back to this catalog so the UI is never empty.
 */
export const TECHWORD_MODEL_CATALOG = [
  { label: 'Claude Opus 5', id: 'claude-opus-5' },
  { label: 'Claude Opus 4.8', id: 'claude-opus-4-8' },
  { label: 'GPT 5.6 Terra', id: 'gpt-5.6-terra' },
  { label: 'GPT 5.6 Sol', id: 'gpt-5.6-sol' }
] as const;

/** The model selected by default the first time a user connects, if the API offers it. */
export const TECHWORD_DEFAULT_MODEL = 'claude-opus-4-8';

export type TechwordCatalogId = (typeof TECHWORD_MODEL_CATALOG)[number]['id'];

export function isCatalogModelId(model: string): model is TechwordCatalogId {
  return TECHWORD_MODEL_CATALOG.some((item) => item.id === model);
}

/** A human label for any model id: catalog name if known, otherwise the raw id. */
export function labelForModel(id: string): string {
  return TECHWORD_MODEL_CATALOG.find((item) => item.id === id)?.label ?? id;
}
