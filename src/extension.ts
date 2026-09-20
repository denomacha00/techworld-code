import * as vscode from 'vscode';
import { labelForModel } from './TechwordConfig';
import { ProviderRegistry } from './providers/ProviderRegistry';
import { AgentViewProvider } from './webview/AgentViewProvider';
import { UpdateChecker } from './update/UpdateChecker';

export function activate(context: vscode.ExtensionContext): void {
  const providers = new ProviderRegistry(context);
  const view = new AgentViewProvider(context, providers);
  const updater = new UpdateChecker(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, view, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(
    vscode.commands.registerCommand('techwordCode.configureProvider', () => connectTechwordApi(providers, view)),
    vscode.commands.registerCommand('techwordCode.selectModel', () => selectModel(providers)),
    vscode.commands.registerCommand('techwordCode.refreshModels', () => verifyTechwordApi(providers)),
    vscode.commands.registerCommand('techwordCode.checkForUpdates', () => updater.check(false)),
    vscode.commands.registerCommand('techwordCode.startTask', async () => {
      view.focus();
      const prompt = await vscode.window.showInputBox({ prompt: 'What should Techword Code build or fix?' });
      if (prompt) { view.submit(prompt); }
    }),
    vscode.commands.registerCommand('techwordCode.stopAgent', () => view.stop()),
    vscode.commands.registerCommand('techwordCode.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { void vscode.window.showInformationMessage('Select code in an editor first.'); return; }
      view.focus();
      void vscode.window.showInformationMessage(`Open Techword Code and ask about ${vscode.workspace.asRelativePath(editor.document.uri)}.`);
    })
  );

  // Check for a newer build shortly after startup (silent: quiet if up to date or the server is down),
  // unless the user turned the startup check off. Delayed so it never competes with activation.
  if (vscode.workspace.getConfiguration('techwordCode').get<boolean>('checkForUpdatesOnStartup', true)) {
    const timer = setTimeout(() => { void updater.check(true); }, 8000);
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }
}

async function connectTechwordApi(registry: ProviderRegistry, view: AgentViewProvider): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    prompt: 'Enter your Techword API key',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : 'A Techword API key is required.')
  });
  if (!apiKey) { return; }

  await registry.saveApiKey(apiKey);
  view.focus();
  void vscode.window.showInformationMessage('Techword API key saved securely. You can start coding now.');
  await verifyTechwordApi(registry);
}

async function verifyTechwordApi(registry: ProviderRegistry): Promise<void> {
  const provider = registry.active();
  const key = await registry.getApiKey();
  if (!provider || !key) { void vscode.window.showInformationMessage('Connect your Techword API key first.'); return; }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking Techword API' },
      () => registry.resolveModels()
    );
    void vscode.window.showInformationMessage('Techword API connected successfully. Choose your model.');
    await selectModel(registry);
  } catch {
    void vscode.window.showErrorMessage('Techword API could not verify this key. Check the key and try again.');
  }
}

async function selectModel(registry: ProviderRegistry): Promise<void> {
  const provider = registry.active();
  if (!provider) { void vscode.window.showInformationMessage('Connect your Techword API key first.'); return; }
  const items = registry.availableModels().map((model) => ({ label: model.displayName ?? labelForModel(model.id), description: model.id, id: model.id }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a coding model' });
  if (!picked) { return; }
  await registry.selectModel(picked.id);
  void vscode.window.showInformationMessage(`Techword Code will use ${picked.label}.`);
}

export function deactivate(): void {}
