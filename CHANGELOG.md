# Changelog

## Unreleased

- Rename the project and Mac app to Open Smart Buttons, including bundle identity, package/artifact names, profile exports, menus, diagnostics and documentation.
- Preserve existing data, preferences and launch settings through compatibility aliases. Fresh installations use the new paths. Report API-key recovery explicitly when macOS cannot unlock an existing encrypted key after the identity change.
- Keep startup and recovery screens available in hardened Mac bundles through a restricted local protocol.

## 0.1.0 — unreleased

First public release.

- **Open Smart Buttons for Mac.** A desktop app with release signing and notarization support for Apple silicon and Intel, first-run onboarding, a menu bar extra (profile, brightness, pause Mac actions), a native app menu, and Settings for login, menu bar, devices, permissions, AI and updates.
- The background service restarts itself after a crash without losing the editor's place, and Repair recovers an unreadable configuration without deleting anything.
- **AI design uses Claude Code or Codex** with your existing sign-in, so there's nothing to set up. An Anthropic API key is the fallback; **Settings ▸ AI** shows which engines are ready.
- Every action in the library runs, including websites, apps, commands, scripts, Shortcuts and Terminal agents. Commands and scripts get your login shell's `PATH`. Missing apps, files, links and shortcuts get a clear message, and a failed press is reported once.
- Quit It and Connect when the Elgato Stream Deck app holds the deck.
- Keys repaint after the Mac wakes from sleep.
- Manual update checks by default; automatic checks are opt-in.
- The Terminal version (`run.command`, `npm start`) keeps working and shares the same data folder.
