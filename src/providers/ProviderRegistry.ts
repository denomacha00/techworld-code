import type * as vscode from 'vscode';
import {
  TECHWORD_API_BASE_URL,
  TECHWORD_API_KEY_SECRET,
  TECHWORD_DEFAULT_MODEL,
  TECHWORD_MODEL_CATALOG,
  TECHWORD_PROVIDER_ID,
  labelForModel
} from '../TechwordConfig';
import { OpenAICompatibleClient } from './OpenAICompatibleClient';
import type { ModelInfo, ProviderConfig } from '../types';

const PROVIDER_KEY = 'techwordCode.techwordProvider';

export class ProviderRegistry {
  constructor(private readonly context: vscode.ExtensionContext) {}

  active(): ProviderConfig | undefined {
    return this.context.globalState.get<ProviderConfig>(PROVIDER_KEY);
  }

  async saveApiKey(apiKey: string): Promise<ProviderConfig> {
    const existing = this.active();
    const provider: ProviderConfig = {
      id: TECHWORD_PROVIDER_ID,
      displayName: 'Techword API',
      baseUrl: TECHWORD_API_BASE_URL,
      authMode: 'bearer',
      apiKeySecretKey: TECHWORD_API_KEY_SECRET,
      selectedModel: existing?.selectedModel ?? TECHWORD_DEFAULT_MODEL,
      discoveredModels: existing?.discoveredModels,
      modelsFetchedAt: existing?.modelsFetchedAt
    };
    await this.context.secrets.store(TECHWORD_API_KEY_SECRET, apiKey);
    await this.context.globalState.update(PROVIDER_KEY, provider);
    return provider;
  }

  async update(provider: ProviderConfig): Promise<void> {
    await this.context.globalState.update(PROVIDER_KEY, provider);
  }

  async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get(TECHWORD_API_KEY_SECRET);
  }

  async removeApiKey(): Promise<void> {
    await this.context.secrets.delete(TECHWORD_API_KEY_SECRET);
    await this.context.globalState.update(PROVIDER_KEY, undefined);
  }

  /**
   * Ask the Techword API which models exist right now, label them from the catalog,
   * and persist the result. Falls back to the full catalog when the API returns nothing,
   * so the picker is never empty. Keeps the user's current selection if it's still offered.
   */
  async resolveModels(): Promise<ModelInfo[]> {
    const provider = this.active();
    const key = await this.getApiKey();
    if (!provider || !key) { throw new Error('Connect your Techword API key first.'); }

    let models: ModelInfo[] = [];
    try {
      const discovered = await new OpenAICompatibleClient(provider, key).listModels();
      const seen = new Set<string>();
      models = discovered
        // Drop namespaced routing aliases (any id containing "/") and duplicates — keep clean, selectable ids.
        .filter((model) => model.id && !model.id.includes('/') && !seen.has(model.id) && seen.add(model.id))
        .map((model) => ({ id: model.id, displayName: labelForModel(model.id) }));
    } catch {
      // Network/API error bubbles up as an empty list; fall back to catalog below.
      models = [];
    }
    if (models.length === 0) {
      models = TECHWORD_MODEL_CATALOG.map((item) => ({ id: item.id, displayName: item.label }));
    }

    const ids = new Set(models.map((model) => model.id));
    const selectedModel = provider.selectedModel && ids.has(provider.selectedModel)
      ? provider.selectedModel
      : ids.has(TECHWORD_DEFAULT_MODEL) ? TECHWORD_DEFAULT_MODEL : models[0]?.id;

    await this.update({ ...provider, discoveredModels: models, modelsFetchedAt: Date.now(), selectedModel });
    return models;
  }

  /** The models to show in the picker: last-resolved list, or the catalog if none resolved yet. */
  availableModels(): ModelInfo[] {
    const discovered = this.active()?.discoveredModels;
    if (discovered && discovered.length > 0) { return discovered; }
    return TECHWORD_MODEL_CATALOG.map((item) => ({ id: item.id, displayName: item.label }));
  }

  async selectModel(id: string): Promise<void> {
    const provider = this.active();
    if (!provider) { throw new Error('Connect your Techword API key first.'); }
    await this.update({ ...provider, selectedModel: id });
  }
}
