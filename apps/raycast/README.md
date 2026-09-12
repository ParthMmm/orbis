# Orbis Raycast extension

Two no-view commands that save one Set to your Orbis library without opening the native app.

- **Save Current Tab** reads the active browser tab through the Raycast Browser Extension.
- **Save Clipboard** takes the first YouTube or SoundCloud link out of the clipboard, even when it sits inside surrounding text.

Both commands validate the link with the same canonical rule the server uses, so an unsupported link never reaches Orbis. They report progress and then a distinct success, duplicate, unsupported, or failure toast. The native app does not need to be running.

## Setup

1. From the repository root, run `bun install`, then `bun run --filter './apps/raycast' dev`. Raycast builds and registers the local extension.
2. [Enroll a device on your Orbis server](../../deploy/orbis-server/README.md#enrol-a-device). Use a separate token for Raycast and keep it out of the repository.
3. Run **Save Current Tab** or **Save Clipboard** in Raycast and enter the extension preferences when asked:
   - **Orbis Service URL**: `https://vanta.tail01d084.ts.net:8444` for the current Vanta deployment. Tailscale must be connected. Include the port and no trailing punctuation.
   - **Device Token**: the token from step 2. The extension only sends it over HTTPS.
4. Install the [Raycast Browser Extension](https://www.raycast.com/browser-extension) in the browser you want **Save Current Tab** to read. **Save Clipboard** does not need it.

For one-shortcut capture, assign **Save Current Tab** a hotkey in Raycast Settings → Extensions → Orbis. The extension does not add a button inside YouTube.

## Development

```
bun install
bun run --filter './apps/raycast' test
bun run --filter './apps/raycast' typecheck
bun run --filter './apps/raycast' build
```

The Raycast manifest `name` ("orbis") is also the workspace package name, because Raycast requires the extension identifier in `package.json`. Filter by the path, or by that name, when running the scripts. `ray build` writes `dist/` and a generated `raycast-env.d.ts`; neither is committed, and the root `bun run check` covers this package too.

## Browser support

On September 11, 2026, the user reported successful capture in Helium/Chromium with the Raycast Browser Extension installed. The initial connection failure came from a trailing period in the service URL; removing it resolved the failure. No macOS automation fallback was needed.

This is a user-confirmed smoke test, not the full live and performance verification required by [Save Sets through Raycast](https://github.com/ParthMmm/orbis/issues/9). Those checks remain open.
