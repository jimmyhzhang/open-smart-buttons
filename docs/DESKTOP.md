# StreamDeckPlus for Mac: how the app is built

The desktop app wraps the same local service and editor that `npm start` runs. Nothing about profiles, actions or the device driver is specific to the app.

```
StreamDeckPlus.app
├─ main process (electron/main.ts) — supervisor only
│    windows · app menu · menu bar extra · preferences · Keychain-held API key · updates · logs
│    ServiceHost ──utilityProcess──▶ service (electron/service-entry.ts → src/server/service.ts)
│        parentPort: start / stop / setInference / repair / testInference
│        WebSocket client (Bearer credential, no Origin) → the editor's own RPC and state pushes
└─ windows (sandboxed, context-isolated, no Node)
     http://127.0.0.1:<port>/            editor          (index.html)
     http://127.0.0.1:<port>/?view=settings   Settings
     http://127.0.0.1:<port>/?view=onboarding first run
     electron/status.html                 shown while the service is starting, restarting or stopped
     window.sdpNative (electron/preload.cjs) — seven calls, each checked again in main
```

## Service supervision

- The port is chosen once, saved in the app's preferences, and reused on every launch, so the editor's origin and its local storage (theme, layout, recent actions) never change. Both credentials are generated once per launch and reused across restarts.
- The service runs with an explicit environment (`HOME`, `PATH`, `LANG`). It never sees `ANTHROPIC_API_KEY` or terminal variables. The API key reaches it only as a message.
- A crash restarts the service after 0.5 s, 1 s and 2 s. A third crash within a minute shows "StreamDeckPlus stopped unexpectedly." with Restart and Show Log.
- Startup errors are typed (`ServiceStartError`): an unreadable configuration offers Repair (writes a repaired copy and keeps the original folder) or Start Fresh (renames the old folder, never deletes it); a data folder held by the Terminal version asks you to quit it there.
- Quit, logout and Restart to Update stop the service first: it flushes the store, releases the deck and removes its lock. The app kills it after 3 s if it does not finish.
- Keep Awake survives a crash restart through a marker in the data folder; a clean quit clears it.

## Security

- Every window denies navigation, redirects, new windows, webviews, permission requests (except writing to the clipboard from the editor) and downloads that the editor did not create as `blob:` URLs.
- The renderer cannot open URLs or files. Opening System Settings, the data folder or the logs goes through fixed commands in the main process.
- Packaged builds set the Electron fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no inspector flags, ASAR integrity on, app code only from the ASAR. `scripts/check-app.mjs` verifies them.
- The app shares `~/.streamdeckplus` with the Terminal version. A liveness lock lets only one of them use it at a time.

## Data and network

- Profiles and images: `~/.streamdeckplus` (same as the Terminal version).
- App preferences and the encrypted API key: `~/Library/Application Support/StreamDeckPlus`.
- Logs: `~/Library/Logs/StreamDeckPlus/StreamDeckPlus.log` (Help ▸ Show Logs). Credentials and API keys are redacted.
- Outbound connections: `api.anthropic.com` when you submit an AI design, and the update host only when you click Check for Updates or turn on automatic checks.

## Development

```sh
npm ci
npm run app:dev                         # build the editor and start the app from source
npx electron . --sdp-profile-dir=/tmp/sdp-try --sim   # isolated profile with a simulated Stream Deck +
npm run test:app                        # Electron end-to-end tests (opens windows)
npm run app:build                       # unpacked StreamDeckPlus.app in dist-app/
npm run app:check -- dist-app/mac-arm64/StreamDeckPlus.app
```

`--sdp-profile-dir` keeps preferences, the key, logs and data in one folder. The app runs the TypeScript sources directly (Electron's Node strips types), so there is no bundling step; keep `electron/` and `src/` within erasable TypeScript syntax.
