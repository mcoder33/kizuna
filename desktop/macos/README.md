# Kizuna for Mac

This folder contains the native macOS shell around Kizuna. It requires macOS 13 or later. The app uses the existing Kizuna account and connects to `https://yourkizuna.com`. Sparkle checks for updates and presents a native banner; offline sync is not provided.

## Build

From the repository root, run:

```sh
./desktop/macos/build.sh
```

The script uses the Swift compiler and Apple frameworks shipped with Xcode Command Line Tools. It creates `desktop/macos/dist/Kizuna.app`, a ZIP, and a DMG. The default binary targets the machine doing the build. Pass `--universal` to build arm64 and Intel slices when the local Swift toolchain supports both targets.

The first build downloads Sparkle 2.10.0 from its official GitHub release and checks a pinned SHA-256. The ignored `vendor/` directory caches the framework. Its own license and signatures are preserved inside the app; the app has no dependency on an external framework installation.

The generated app is ad-hoc signed for local testing. It is not Developer ID signed or notarized. macOS Gatekeeper may block an app downloaded from the internet because its developer cannot be verified. For public distribution, sign with a Developer ID certificate and notarize the app or disk image through Apple.

## Prepare a public update

1. Increase `CFBundleShortVersionString` and the monotonically increasing `CFBundleVersion` in `Info.plist`.
2. Run `bash desktop/macos/build.sh --universal`, then run the checks below.
3. Run `bash desktop/macos/prepare-update.sh`. It creates a versioned ZIP and signed `appcast.xml` in `desktop/macos/dist/updates/`. It verifies that the signing key matches the public key embedded in the app and refuses to overwrite a previously prepared build. This step does **not** publish anything.
4. **Only when releasing:** copy the prepared ZIP files and `appcast.xml` to `public/downloads/mac/`. Keep versioned archives immutable. Copy `desktop/macos/dist/Kizuna.dmg` to `public/downloads/Kizuna-mac.dmg`, and refresh `public/downloads/SHA256SUMS` with `shasum -a 256 Kizuna-mac.dmg` from that directory.
5. Publish through the repository's normal `main` deployment workflow. Verify the public feed and archive before considering the release complete. Publish archives before the feed if uploading separately.

The feed URL is `https://yourkizuna.com/public/downloads/mac/appcast.xml`. Both the feed and the archive must have valid Ed25519 signatures; archives are verified before extraction. Signing failures never expire into acceptance. No custom downloader, executable installer script, or update API is exposed to the web page.

The private update-signing key is stored in the macOS login Keychain under the Sparkle account `space.agenthub.kizuna.updates`. Only its public counterpart (`SUPublicEDKey`) is committed. Keep a secure backup of the signing key before the first release. Never put it in the repository or on the public web server. `generate_keys --account space.agenthub.kizuna.updates -p` prints only the public key. On a different release machine, import the existing key using Sparkle's `generate_keys`; do not replace it with a newly generated key. Future CI signing must use a protected secret.

Versions up to 1.0.2 do not contain an updater. Their users need one manual installation of the first updater-enabled build. After that, the banner handles subsequent versions. Updating the website alone does not replace the native application.

## Update experience

- Automatic checks use Sparkle's regular schedule (normally once a day); **Проверить обновления…** is available in both app menus.
- A new version appears in a non-modal banner with **Обновить приложение**, **Отложить на 1 час**, **Не показывать больше**, and a close button. The website remains usable. No download or installation starts until the user clicks the update button.
- Closing the initial offer hides this build until the next local calendar day. The hour button reminds after 3600 seconds. **Не показывать больше** hides only the offered build; future builds are still offered. Decisions survive relaunch. A due reminder starts its own background check, retrying after 15 seconds while Sparkle is busy. A newer offered build cancels the obsolete reminder.
- **Проверить обновления…** always bypasses reminders and ignored builds; merely checking does not move the reminder deadline. Clicking the update button clears that build's reminder and ignored state. These extra controls are available only before downloading. Download cancellation and **Позже** on an already prepared update keep their existing behavior.
- The same banner shows download and extraction progress. The download can be cancelled.
- After the requested download, installation and relaunch continue automatically. A quick-capture draft, a changed web editor, unsent conversation text, an unsaved note, or an in-flight write delays the restart. The banner asks the user to finish the edit and continue. It never sends unfinished text on their behalf. Web editing is locked only after the restart check succeeds and unlocked if the update fails.
- The webpage's `kizuna:before-update` event reports in-memory chat drafts and completed note autosaves to the native restart guard. Publish these small web changes with the first updater-enabled release. They have no effect in an ordinary browser.
- Network failures and invalid signatures leave the existing app installed. A user-initiated failure is shown in the banner; a new check can be started from the menu.

## Local verification

```sh
bash desktop/macos/build.sh --universal
desktop/macos/dist/Kizuna.app/Contents/MacOS/Kizuna --self-test
python3 desktop/macos/Tests/test-updates.py
bash desktop/macos/Tests/test-reminders.sh
bash desktop/macos/Tests/test-notifications.sh
# With npm dependencies and Playwright Chromium installed:
node --test desktop/macos/Tests/restart-guard.test.cjs
```

The integration test creates disposable app bundles with unique identifiers, an ephemeral signing key and a loopback HTTP server. Its ten scenarios test a real signed update from build 1 to build 2 including relaunch, deferred restart for a draft, deferral, cancellation, a corrupted archive, a modified feed, an unavailable server, no new version, the new reminder controls with background suppression and manual bypass, and a manual check requested during Sparkle’s asynchronous installer probe. The reminder scenario uses an injected clock and scheduler without waiting an hour. The Foundation checks cover persistence, version scope, local midnight through daylight-saving changes, due checks, busy retries and stale callbacks. Neither test opens the user's installed Kizuna or contacts production. `dist/update-banner.png` is a render of the native banner from this fixture.

Developer ID signing/notarization and Gatekeeper behavior on another Mac still need validation before public distribution. The local integration test deliberately uses ad-hoc signed fixture applications; it does not establish notarization readiness.

## Try the update interactively

From the repository root, run:

```sh
python3 desktop/macos/Tests/test-updates.py --demo
```

An independent **Кизуна — демо обновления 1.0** window opens in front. Click **Обновить приложение** in its native banner to watch the download, installation and relaunch. The updated window stays open with **Демо обновлено до версии 2.0**. After dismissing the offer or cancelling, use **Проверить обновление снова** to show the offer again, bypassing the reminder or ignored build.

Close the demo window or press **Ctrl+C** in the Terminal to stop it and remove its temporary files. The demo uses disposable app bundles, a new ephemeral signing key and a feed on `127.0.0.1`; it never opens the installed Kizuna, uses an account, contacts production or publishes a release. This previews the real Sparkle update flow without testing first-install Gatekeeper behavior.

## Behavior and limits

- Press **Command-Shift-Space** to open a small new-entry window from any app while Kizuna is running. Closing the main window leaves the app available from the menu bar.
- The menu bar draws the Kizuna torii mark as a transparent monochrome template, so macOS adapts it to light and dark appearances.
- Notifications require explicit opt-in from the app menu or the notification controls in Settings. The same controls show native permission status, disable delivery on this Mac, and send a local test banner. A macOS denial explains where to restore permission. While the app runs (including with its window closed), it checks about once a minute and immediately after wake, activation, and login. It handles up to the 60 most recent items, once per successfully delivered notification ID; failed OS submissions are retried. Quiet hours and per-kind account preferences still apply. Historical items at first login are not replayed. Delivery while the app is quit or the Mac is asleep is not provided.
- The current day refreshes across midnight and immediately after wake/activation without reloading the web page or discarding drafts.
- Sign in to an existing Kizuna account through the app's browser view. The app connects to the existing Kizuna server.
- There is no offline sync. The update banner updates the native app; **Вид → Обновить** (⌘R) reloads only the web page.
