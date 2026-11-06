# Contributing

Install Node.js 22.18 or later. Run `npm ci` once to install the lockfile dependencies, then run `npm run verify`. The verification command checks TypeScript, device and engine unit tests, isolated HTTP and WebSocket tests, and the production UI. The automated inference test uses a local stub.

On macOS, `scripts/verify-offline.sh` runs the same checks with outbound connections restricted to loopback. CI runs this gate on Apple Silicon and Intel runners.

Run `npm run sim` to start with a simulated deck and Mac effects off. Open the launch link printed in the terminal. For an isolated profile, use `npm run sim -- --data /path/to/empty-directory --port 4418`.

The same transport interface connects the hardware and simulator. Keep packet formats in `src/protocol/`, device transport and lifecycle in `src/device/`, action dispatch and rendering coordination in `src/engine/`, and client-facing mutations in `src/server/`. Add test coverage for changes at the boundary that consumes them.

For live frontend development, run `npm run dev` and `npm run dev:ui`. Use the session fragment printed by the server with `http://127.0.0.1:5173/`. That dev origin is accepted only in dev mode.
