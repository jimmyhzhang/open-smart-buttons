# Release checklist

`npm run export:source -- /path/to/new-directory` builds a local source candidate from the manifest allowlist. The export includes the lockfile. Inspect the actual candidate, including tests and assets, before sharing it. Keep the package marked private unless a registry release has been explicitly chosen.

- Verify the export includes `LICENSE`, `THIRD_PARTY_NOTICES.md`, and matching MIT package metadata. Check ownership and redistribution terms for any new or changed third-party material.
- Build from the exported source with the lockfile. For any distribution that includes build output or installed dependencies, inventory the bundled components and satisfy their redistribution terms.
- Run `npm run verify` in the export. Test the minimum supported Node version and each advertised macOS architecture.
- Install on a clean Mac. With networking disabled after setup, check the launch link, simulator, action configuration, and USB device connection.
- Verify a live inference request and record permitted destinations and blocked redirects. The CLI account used during development is independent of the app's inference configuration.
- Check physical reconnect, profile and page routing, state-driven appearance and permission failures on each claimed hardware tier. Mark hardware exercised only on the simulator accordingly.
- Inspect the final archive and history for credentials, machine-specific metadata, local working files, and unreviewed assets.

## Mac app release

Releases are cut by pushing a `vX.Y.Z` tag that matches `version` in `package.json`. CI (`.github/workflows/verify.yml`) then:

1. runs the source checks and the Electron end-to-end tests on Apple silicon and Intel runners;
2. builds, signs with Developer ID, notarizes and staples each architecture on its native runner (`node scripts/build-electron.mjs --dist --arch <arch>`);
3. checks every app with `node scripts/check-app.mjs <app> --release`: signature, Gatekeeper, stapled ticket, security fuses, native module architecture, archive contents, and a launch self-test that loads USB support, renders a key and serves the editor;
4. merges the two `latest-mac.yml` update feeds and drafts a GitHub Release with both DMGs and update zips.

Keep `repository`, `homepage` and `bugs` in `package.json`, and the README Releases link, pointed at the project repository so a DMG or source archive leads back to its source.

Repository secrets: `MAC_CERTIFICATE_P12_BASE64` and `MAC_CERTIFICATE_PASSWORD` (a Developer ID Application certificate), `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (an App Store Connect API key for notarization). Without them CI builds ad-hoc signed apps and still runs every local check.

Before publishing the draft:

- Install each DMG on a clean Mac of that architecture. Confirm there is no Gatekeeper warning, onboarding reaches a key press, and System Settings › Privacy lists **Open Smart Buttons** for Accessibility and Automation.
- Update from the previous release on both architectures. Profiles and permission grants must survive.
- With automatic update checks off, confirm the app makes no non-loopback connection for 10 minutes (`nettop -p "Open Smart Buttons"`).
- Keep using one signing identity. A different certificate resets every user's Accessibility and Automation grants.

Local builds: `npm run app:build` makes an unpacked app for this Mac (signed with a Developer ID or Apple Development identity if the keychain has one, else ad-hoc), `npm run app:dmg` adds the DMG, and `npm run app:check -- <app>` runs the checks without the release-only ones.

Known advisory: `npm audit` reports a moderate `minimatch` advisory through `electron-builder`. It affects build-time glob matching of this repository's own patterns, not the shipped app.

## Data recovery

Stop the server before backing up the data directory, usually `~/.open-smart-buttons`. Copy the entire directory to retain images and AI job history. A JSON profile export carries settings and image references. A standalone JSON file cannot restore image bytes.

After a crash, inspect the PID stored in `server.lock` and confirm that no Open Smart Buttons process owns the directory before removing the stale lock.

In the Mac app, an unreadable configuration shows **Repair**, which does the following automatically and keeps the original folder next to the repaired one.

If the Terminal version reports an invalid profile at startup, stop the server and run `npm run recover -- "$HOME/.open-smart-buttons" "$HOME/.open-smart-buttons-recovered"`. Choose a destination that does not exist. Recovery writes a separate data directory and a byte-for-byte original config backup. It moves orphan folders and overflow actions onto reachable pages and preserves missing folder actions as inactive entries with their original settings. The original directory and AI design history stay where they are. Recovery stops on ambiguous ownership or invalid data it cannot repair.

Open the result with `./run.command --data "$HOME/.open-smart-buttons-recovered"` and check the recovered pages before using it as your main data directory.
