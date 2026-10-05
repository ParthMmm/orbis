# Verify the Apple UI

Automated journeys run through [native lanes](../development.md#native-clients). Use this procedure when checking a real build by hand. [Historical September notes](../audits/2026-09-native-verification-notes.md) retain the measured findings and tool behavior from those builds.

## Choose the build and target

1. Build and install the revision being checked. Record its commit and the installed app's binary digest. A build on disk is not evidence of what the device runs.
2. Name the platform, simulator ID, and session before opening the app. Confirm the target before trusting a snapshot. Simulators can share display names across runtimes.
3. In T3, use `device_list` and `device_open` for simulator checks. Keep the exact launcher, host configuration, and session flags returned by `device_open` on each agent-device command.

For a Mac-hosted CLI session outside T3, select an explicit target:

```sh
	agent-device open app.orbis.client --platform ios --device "<simulator name>" --session orbis-ios --foreground
```

## Use isolated data

For filing, renaming, and removal, use the native lane's disposable service and pairing. [Development](../development.md#find-the-implementation) identifies the fixture runner and client. The production library is in the Group, not the local development SQLite database.

For a production acceptance check, use the issue's approved scope and existing key handling. Record the original pairing and restore it afterwards. Verify the restored connection before finishing.

## Check the environment before the product

Dismiss system alerts and credential sheets before judging an interaction. An Apple Account Verification alert or password prompt can intercept taps while the app still updates underneath it. Inspect the screenshot as well as the accessibility tree.

Take a fresh `snapshot -i` before selecting a ref. After an interaction, use refs from its settled frame or a new snapshot. Take a fresh snapshot for each timed reading too; a stale read can return an old value without an error.

Use exact refs when labels match several nodes. Confirm the expected heading, value, or navigation destination after the action. A non-empty tree diff records change, not completion of the intended action.

## Measure the claim

Read the control's frame, enabled state, and hittability before reporting clipping or occlusion. Compare its bounds with the window and neighboring controls. Check the end of a scrollable list before judging its footer.

For a control that appears unresponsive, exercise a known working control on the same build and screen. For a toggle, test both states and the return transition. When XCUITest cannot compute a hit point, compare its element frame with a manual tap before concluding the layout is broken.

Use screenshots to show the state and geometry reads to support the claim. Record which scroll position and playback state the measurement covers.

## Preserve the result

Retain the [verification record and artifacts](../development.md#retain-verification-evidence). Include the steps, expected state, and observed state. Mark checks that were not exercised as unverified.
