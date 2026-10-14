# Orbis Raycast extension

Three commands. Two save one Set to your Orbis library without opening the native app, and one signs Raycast in.

- **Sign In** takes a Sign-in Code and keeps the key Orbis returns in Raycast's encrypted storage.
- **Save Current Tab** reads the active browser tab through the Raycast Browser Extension.
- **Save Clipboard** takes the first YouTube or SoundCloud link out of the clipboard, even when it sits inside surrounding text.

Both save commands validate the link with the same canonical rule the server uses, so an unsupported link never reaches Orbis. They report progress and then a distinct success, duplicate, unsupported, or failure toast. The native app does not need to be running.

## Setup

1. From the repository root, run `bun install`, then `bun run --filter './apps/raycast' dev`. Raycast builds and registers the local extension.
2. In Orbis Settings on a device you already use, show a Sign-in Code.
3. Within 10 minutes, run **Sign In** in Raycast and type the code. The device appears as "Raycast" on your Devices list.
4. Install the [Raycast Browser Extension](https://www.raycast.com/browser-extension) in the browser you want **Save Current Tab** to read. **Save Clipboard** does not need it.

For one-shortcut capture, assign **Save Current Tab** a hotkey in Raycast Settings → Extensions → Orbis. The extension does not add a button inside YouTube.

The **Orbis Service URL** preference defaults to `https://orbis.p11a.xyz/api`, and the extension sends a code or key only over HTTPS. The **Device Token** preference is for setups from before **Sign In**; a key from **Sign In** takes its place. To sign in as another Person, run **Sign In** again.

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
