import * as vscode from 'vscode';
import { TECHWORD_UPDATE_URL } from '../TechwordConfig';
import { isNewerVersion, parseManifest, resolveVsixUrl, type UpdateManifest } from './updateLogic';

/**
 * Checks a release server (update-server/ on Railway) for a newer Techword Code build and, on the user's
 * click — or automatically if they turned auto-update on — downloads the .vsix and installs it, then
 * offers to reload the window so the new version takes effect. VS Code only auto-updates extensions that
 * come from a marketplace; a self-hosted .vsix does not, so this fills that gap for the white-label build.
 */
export class UpdateChecker {
  private checking = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get currentVersion(): string {
    const v = (this.context.extension.packageJSON as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('techwordCode');
  }

  private manifestUrl(): string {
    const override = this.config().get<string>('updateUrl', '').trim();
    return override || TECHWORD_UPDATE_URL;
  }

  /** Fetch + validate the release manifest. Returns undefined on any network/parse problem (never throws). */
  private async fetchManifest(url: string): Promise<UpdateManifest | undefined> {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) { return undefined; }
      const raw: unknown = await response.json();
      return parseManifest(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * Check for an update. `silent` (startup path) stays quiet when already up to date or the server is
   * unreachable; a manual "Check for updates" (silent=false) reports both outcomes so the click isn't a
   * no-op. When auto-update is on and a newer version exists, it installs without prompting first.
   */
  async check(silent: boolean): Promise<void> {
    if (this.checking) { return; }
    this.checking = true;
    try {
      const url = this.manifestUrl();
      const manifest = await this.fetchManifest(url);
      if (!manifest) {
        if (!silent) { void vscode.window.showWarningMessage('Techword Code could not reach the update server. Check your connection and try again.'); }
        return;
      }
      if (!isNewerVersion(this.currentVersion, manifest.version)) {
        if (!silent) { void vscode.window.showInformationMessage(`Techword Code is up to date (v${this.currentVersion}).`); }
        return;
      }
      const vsixUrl = resolveVsixUrl(url, manifest.vsixUrl);
      if (!vsixUrl) {
        if (!silent) { void vscode.window.showWarningMessage('An update is available but its download link is invalid. Contact the developer.'); }
        return;
      }

      const autoUpdate = this.config().get<boolean>('autoUpdate', false);
      if (autoUpdate) {
        await this.download(manifest, vsixUrl);
        return;
      }

      const notes = manifest.notes ? `\n\n${manifest.notes}` : '';
      const choice = await vscode.window.showInformationMessage(
        `Techword Code v${manifest.version} is available (you have v${this.currentVersion}).${notes}`,
        'Update now',
        'Later'
      );
      if (choice === 'Update now') { await this.download(manifest, vsixUrl); }
    } finally {
      this.checking = false;
    }
  }

  /** Download the .vsix to a temp file, install it, and offer to reload so the new version takes effect. */
  private async download(manifest: UpdateManifest, vsixUrl: string): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Updating Techword Code to v${manifest.version}…` },
        async () => {
          const response = await fetch(vsixUrl, { signal: AbortSignal.timeout(120000) });
          if (!response.ok) { throw new Error(`download failed (HTTP ${response.status})`); }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength < 1000) { throw new Error('downloaded file is too small to be a valid package'); }
          // Write into the extension's own global storage (always writable), then install from there.
          await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
          const target = vscode.Uri.joinPath(this.context.globalStorageUri, `techword-code-${manifest.version}.vsix`);
          await vscode.workspace.fs.writeFile(target, bytes);
          await vscode.commands.executeCommand('workbench.extensions.installExtension', target);
          void vscode.workspace.fs.delete(target).then(undefined, () => undefined); // best-effort cleanup
        }
      );
    } catch (error) {
      void vscode.window.showErrorMessage(`Techword Code update failed: ${error instanceof Error ? error.message : String(error)}. You can install the latest .vsix manually.`);
      return;
    }
    const reload = await vscode.window.showInformationMessage(
      `Techword Code updated to v${manifest.version}. Reload to finish.`,
      'Reload now',
      'Later'
    );
    if (reload === 'Reload now') { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
  }
}
