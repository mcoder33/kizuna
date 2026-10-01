# Kizuna for Mac

This folder contains the native macOS shell around Kizuna. It requires macOS 13 or later. The app uses the existing Kizuna account and server; it does not provide offline sync or an automatic updater.

## Build

From the repository root, run:

```sh
./desktop/macos/build.sh
```

The script uses the Swift compiler and Apple frameworks shipped with Xcode Command Line Tools. It creates `desktop/macos/dist/Kizuna.app`, a ZIP, and a DMG. The default binary targets the machine doing the build. Pass `--universal` to build arm64 and Intel slices when the local Swift toolchain supports both targets.

The generated app is ad-hoc signed for local testing. It is not Developer ID signed or notarized. macOS Gatekeeper may block an app downloaded from the internet because its developer cannot be verified. For public distribution, sign with a Developer ID certificate and notarize the app or disk image through Apple.

## Prepare a public update

1. Bump `CFBundleShortVersionString` and `CFBundleVersion` in `Info.plist`.
2. Run `./desktop/macos/build.sh --universal` and verify both CPU slices are listed.
3. Copy `desktop/macos/dist/Kizuna.dmg` to `public/downloads/Kizuna-mac.dmg`.
4. From `public/downloads`, refresh the checksum with `shasum -a 256 Kizuna-mac.dmg > SHA256SUMS`.
5. Check the downloaded artifact against the generated DMG with `shasum -a 256` and run `hdiutil verify`.

The website serves files under `public/` directly. Publishing the updated Mac download therefore follows the repository's normal `main` deployment workflow.

## Behavior and limits

- Press **Command-Shift-Space** to open a small new-entry window from any app while Kizuna is running. Closing the main window leaves the app available from the menu bar.
- The menu bar draws the Kizuna torii mark as a transparent monochrome template, so macOS adapts it to light and dark appearances.
- Notifications require explicit opt-in from the app menu. While the app is open, it checks for notifications about once a minute and handles up to the 60 most recent items, once per notification ID.
- Sign in to an existing Kizuna account through the app's browser view. The app connects to the existing Kizuna server.
- There is no offline sync or automatic updating in this build.
