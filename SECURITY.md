# Security policy

Open Smart Buttons runs a local service that can press keys and control apps on your Mac, so security reports are welcome.

## Reporting a vulnerability

Report privately through the repository's **Security → Report a vulnerability** (GitHub private vulnerability reporting). Please do not open a public issue. Include the version (Settings ▸ About, or `package.json`), macOS version and architecture, and steps to reproduce.

You should get a reply within a week. Fixes ship in a new release; the advisory is published once an update is available.

## Scope

In scope: the local HTTP and WebSocket service (`src/server/`), its authentication and origin checks, the optional local-only action mode, the Mac app's main process, preload and window lockdown (`electron/`), update verification, how AI design invokes Claude Code and Codex, and the handling of the Anthropic API key.

The threat model and the protections in place are described in [docs/DESKTOP.md](docs/DESKTOP.md) (Mac app) and in the README's "Network and data" section.
