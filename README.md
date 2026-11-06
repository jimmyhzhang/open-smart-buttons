# StreamDeckPlus

A macOS-first controller and editor for **Stream Deck Neo** and **Stream Deck +**, without the Stream Deck app. A local service talks to the deck over USB, and the editor runs on your Mac. Nothing leaves your Mac unless you ask for it.

## StreamDeckPlus for Mac

Download the DMG for your Mac (Apple silicon or Intel) from the project's Releases page and drag StreamDeckPlus to Applications. macOS 13 or later.

The first launch walks you through plugging in the deck and, optionally, letting keys press shortcuts on your Mac. After that, StreamDeckPlus lives in the menu bar: switch profiles, change brightness, pause Mac actions, or open the editor. Closing the editor window keeps your deck working.

- **Elgato Stream Deck is open?** Only one app can use the deck. Choose **Quit It and Connect** in the menu bar or the editor.
- **Keys that press shortcuts** need Accessibility and Automation access for StreamDeckPlus. Open **Settings ▸ Permissions** to check and grant them.
- **Settings** (⌘,) holds Open at login, Show in menu bar, device brightness and sleep, the optional Claude API key, and updates.

To build the app yourself, see [the desktop app guide](docs/DESKTOP.md).

## Run from Terminal

Install Node.js 22.18 or later. Set up the checkout once.

```sh
npm ci
npm run build:ui
```

Double-click `run.command` or run it from Terminal. It opens the editor in your browser with a temporary session credential. If the browser is closed, use the launch link printed in Terminal. Keep that link private. Restarting rotates the credential. The Terminal version and the app share the same data folder, so run one at a time.

The normal launcher uses the built assets and installed dependencies. Setup may download packages. Stop any older StreamDeckPlus server before upgrading an existing data directory. If the official app holds the USB handle, quit it yourself and select **Reconnect** in the device menu.

| Command | Purpose |
| --- | --- |
| `npm run app:dev` | Start the Mac app from source. |
| `npm run sim` | Launch a simulator with USB and Mac effects off. The saved USB execution preference is preserved. Open the printed link. |
| `npm run doctor` | Read permissions and key mappings from the running editor (the app or Terminal version). Add `-- --listen` to see input for 30 seconds. For another server, pass its `--port` and `--data` values. |
| `npm run probe` | Optional USB diagnostic that claims the device, changes brightness, and paints a test pattern. Stop other apps that use the deck first. |
| `npm run verify` | Run TypeScript checks, automated tests, and the production build. |

## Set up a button

1. Select a key or dial. Press **⌘K** or click **Browse actions**.
2. Choose a local action, configure it, and save. Use **Configure** to edit it later or press the virtual key in **Use** mode to simulate it. To run Mac effects from a USB deck, enable **Perform actions from USB decks on this computer** in Settings.
3. Use **More key options** to change a button's look with Mac state. For example, show a crossed-out speaker when muted or a different icon while a chosen app is running.

Use the device menu to disconnect or reconnect. On Neo, the two touch points can switch pages or adjust volume. Profiles support pages, folders, and model-specific controls. Some Mac controls require Accessibility or Automation consent for the app that launched StreamDeckPlus. Use the permission prompt in Settings to check access.

The editor can import StreamDeckPlus JSON and Elgato profile archives. Existing external actions stay in the profile and are identified as unavailable when selected. PNG and JPEG images within the upload limits are supported. Replace legacy images in other formats to show them on the deck again. Back up the whole data directory when moving profiles and images to a new machine.

## Optional AI design

Select a key and describe a local action in **Create with AI** or **Edit with AI**. The service sends the request and relevant selected local action to Claude and validates the returned settings, icon and state rules before saving. Generated executable code is outside the local action policy. AI design runs when you submit it, including while Mac actions are paused.

In the app, add a Claude API key in **Settings ▸ AI**. It is encrypted with your Mac's Keychain and never shown to the editor. From Terminal, launch with `ANTHROPIC_API_KEY` and `STREAMDECK_CLAUDE_MODEL` in the environment. Choose a model with structured output support. This uses the Claude API; a Claude CLI sign-in is a separate credential.

## Network and data

The editor and device service communicate over loopback (`127.0.0.1`). StreamDeckPlus makes only two kinds of outbound request:

- **Claude** (`api.anthropic.com`), only when you submit an AI design. It uses a fixed TLS destination and rejects redirects.
- **Updates** (the project's GitHub Releases), only in the Mac app, only when you click **Check for Updates** or turn on **Check automatically** (off by default). Updates are signature-checked before they install.

The local action policy blocks website and app launches, arbitrary keyboard and shell commands, executable scripts, Shortcuts, launcher links, and interactive coding-agent handoffs. Built-in Mac controls and deck actions remain available.

By default the data directory is `~/.streamdeckplus`. It holds profiles, images, and the last 20 AI jobs. Use **Design history → Clear design history** to remove the job records and their undo history. Profile exports can contain prompts, snippets, and local paths. Review them before sharing. The Mac app keeps its preferences and the encrypted API key in `~/Library/Application Support/StreamDeckPlus` and its log in `~/Library/Logs/StreamDeckPlus`. See [release and recovery instructions](docs/RELEASE.md), [the desktop app guide](docs/DESKTOP.md) and [contributor setup](docs/CONTRIBUTING.md).

## Hardware scope

The Neo has been used with a physical device. The Stream Deck + simulator exercises its key, dial, and touch-strip paths at the HID report layer. Other recognized models share parts of the driver and need separate physical validation before claiming release support.

## Acknowledgments

Thanks to the maintainers and contributors of
[python-elgato-streamdeck](https://github.com/abcminiuser/python-elgato-streamdeck) and
[rust-elgato-streamdeck](https://github.com/OpenActionAPI/rust-elgato-streamdeck) for their open-source
work supporting Stream Deck hardware.

## License

StreamDeckPlus is available under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licensing.
