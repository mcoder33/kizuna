# Kizuna for Mac

This folder contains the native macOS shell around Kizuna. It requires macOS 13 or later. The app uses the existing Kizuna account and server; it does not provide offline sync or an automatic updater.

## Build

From the repository root, run:

```sh
./desktop/macos/build.sh
```

The script uses the Swift compiler and Apple frameworks shipped with Xcode Command Line Tools. It creates `desktop/macos/dist/Kizuna.app`, a ZIP, and a DMG. The default binary targets the machine doing the build. Pass `--universal` to build arm64 and Intel slices when the local Swift toolchain supports both targets.

The generated app is ad-hoc signed for local testing. It is not Developer ID signed or notarized. macOS Gatekeeper may block an app downloaded from the internet because its developer cannot be verified. For public distribution, sign with a Developer ID certificate and notarize the app or disk image through Apple.

## Behavior and limits

- Press **Command-Shift-Space** to open quick capture while the app is running. Closing the window leaves the app available from the menu bar.
- Notifications require explicit opt-in from the app menu. While the app is open, it checks for notifications about once a minute and handles up to the 60 most recent items, once per notification ID.
- Sign in to an existing Kizuna account through the app's browser view. The app connects to the existing Kizuna server.
- There is no offline sync or automatic updating in this build.
