# Techword Code

Techword Code is an approval-first VS Code coding agent powered by **Techword API**. It reads a project, makes surgical edits, runs tests/builds, fixes its own errors, and keeps working across a whole codebase — with the user in control of every change.

API keys are stored only in VS Code SecretStorage; they are never written to VS Code settings or your project files.

## Capabilities
- **Surgical editing** — `edit_file` replaces exact snippets (cheap/safe on large files); create/rename/delete via `propose_file_edits`. Every change is an inline diff and can be **reverted** (checkpoints).
- **Self-verifying** — after edits it runs your build/tests/linter and reads the editor's **Problems** (`get_diagnostics`), then fixes and re-runs until green (with a guard against blind loops).
- **Code map for big repos** — `code_map` builds a ranked, dependency-free index of the most important files and their symbols so the agent knows where things live across huge codebases without reading everything.
- **Code intelligence (LSP)** — `find_symbol` (workspace symbols), `outline_file` (file structure without reading it all), `find_usages` (references + definition) for precise navigation in big codebases.
- **Parallel exploration** — `spawn_explorer` delegates read-only investigation to sub-agents that return just the findings, keeping the main context clean; several can run **concurrently** for speed. grep/list respect `.gitignore`.
- **MCP support** — connect external [Model Context Protocol](https://modelcontextprotocol.io) servers via the `techwordCode.mcpServers` setting; their tools become available to the agent (approval-gated) as `mcp__<server>__<tool>`.
- **Asks when unsure** — `ask_user` pauses for your answer instead of guessing. `web_fetch` looks up docs/npm online. `preview_in_chat` shows generated images/SVGs inline.
- **Plan / Act modes**, **project rules** (`AGENTS.md` / `.techwordrules` / `CLAUDE.md`) and **custom instructions**.
- **Safe autonomy** — with *partial* auto-approve (only edits, or only commands), a command-safety policy still requires a human click for dangerous commands (`rm -rf`, disk format, force push, `curl | sh`, `sudo`, …); add your own via `techwordCode.blockedCommands`. **Bypass permissions** mode removes all gating — every edit and command runs unattended, including destructive ones — for a trusted project or an overnight run, exactly like Claude Code's bypass mode. Configurable step budget for long tasks, auto-retry on transient failures, never hangs silently, Stop halts work (including running commands) instantly.
- **UX** — streaming, live activity cards, syntax-highlighted code + colored diffs, attachments + image vision, saved history, type-while-working, copy, per-project auto-approve, token counter, context auto-compaction.

## Settings
`maxSteps`, `maxTokens`, `temperature`, `contextMode` (auto/ask compaction), `contextTokenLimit`, `enableWebFetch`, `openFilesInEditor`, `customInstructions`, `maxToolOutputChars`, `deniedGlobs`, `blockedCommands`, `mcpServers`. Auto-approve (file edits / commands) is a per-project toggle in the panel's Settings.

## Models
Techword Code shows whatever coding models the Techword API offers at connect time. Known models are labelled:

- **Claude Opus 5** — `claude-opus-5`
- **Claude Opus 4.8** — `claude-opus-4-8` (default)
- **GPT 5.6 Terra** — `gpt-5.6-terra`
- **GPT 5.6 Sol** — `gpt-5.6-sol`

If the API adds or removes a model, the picker updates the next time you connect. If the API returns nothing, the full known list is shown as a fallback.

## User workflow
1. Install the `techword-code-*.vsix` extension package in VS Code.
2. Open the **Techword Code** view in the Activity Bar.
3. Click the gear (⚙) and paste your Techword API key, then **Save & connect**.
4. Pick a model from the dropdown in the header or settings.
5. Describe the coding task in the chat box (Ctrl/Cmd+Enter to send).
6. Review each proposed change inline — diffs for file edits, the exact command for terminal runs — and click **Approve** or **Reject**.

## Development
```powershell
npm install
npm run build      # bundle the extension
npm run package    # produce techword-code-<version>.vsix
```

Open this folder in VS Code and press `F5` to test it in an Extension Development Host.

The Techword API endpoint is set once in `src/TechwordConfig.ts` (`TECHWORD_API_BASE_URL`); it is an internal release setting and is not requested from extension users.

The extension icon is generated with `node scripts/make-icon.js` → `resources/icon.png`.
