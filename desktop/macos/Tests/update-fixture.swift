import AppKit
import Sparkle

@main
enum UpdateFixture {
    static func main() {
        let app = NSApplication.shared
        let delegate = FixtureDelegate()
        app.delegate = delegate
        app.setActivationPolicy(delegate.mode == "demo" ? .regular : .accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    lazy var reminderPolicy = UpdateReminderPolicy(clock: { [weak self] in
        guard let self, self.mode == "reminders" else { return Date() }
        return self.reminderDate
    })
    lazy var updates = DesktopUpdates(reminderPolicy: reminderPolicy, scheduleReminder: { [weak self] delay, fire in
        if let self, self.mode == "reminders" {
            self.reminderFirings.append(fire)
            self.reminderDelays.append(delay)
            return {}
        }
        return UpdateReminderController.scheduleTimer(delay: delay, fire: fire)
    })
    var reminderDate = Date(timeIntervalSince1970: Date().timeIntervalSince1970.rounded(.down))
    var reminderFirings: [@MainActor () -> Void] = []
    var reminderDelays: [TimeInterval] = []
    var reminderStep = 0
    var reminderCheckAfter = Date.distantPast
    var window: NSWindow!
    var timer: Timer?
    var previous = ""
    var draftBlocked = false
    var finished = false
    let mode = Bundle.main.object(forInfoDictionaryKey: "TestMode") as! String
    let result = Bundle.main.object(forInfoDictionaryKey: "TestResult") as! String
    func log(_ message: String) {
        let data = Data((message + "\n").utf8)
        if !FileManager.default.fileExists(atPath: result) { FileManager.default.createFile(atPath: result, contents: nil) }
        let file = FileHandle(forWritingAtPath: result)!
        file.seekToEndOfFile(); file.write(data); try? file.close()
    }
    func finish(_ message: String) {
        guard !finished else { return }; finished = true
        log(message); timer?.invalidate(); NSApp.terminate(nil)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let path = Bundle.main.object(forInfoDictionaryKey: "TestProcessFile") as? String {
            try? String(ProcessInfo.processInfo.processIdentifier).write(toFile: path, atomically: true, encoding: .utf8)
        }
        let installed = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String == "2"
        if installed && mode != "demo" { finish("INSTALLED 2"); return }
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 760, height: mode == "demo" ? 480 : 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Кизуна — локальная проверка обновления"; window.isReleasedWhenClosed = false
        if mode == "demo" {
            window.title = "Кизуна — демо обновления \(installed ? "2.0" : "1.0")"
            window.delegate = self
            let title = NSTextField(labelWithString: installed ? "Демо обновлено до версии 2.0" : "Демо Кизуны · версия 1.0")
            title.font = .systemFont(ofSize: 24, weight: .semibold)
            let description = NSTextField(wrappingLabelWithString: installed
                ? "Обновление установилось, приложение перезапустилось.\nЭто отдельное демо; ваша Кизуна не менялась.\nЗакройте окно, чтобы завершить проверку."
                : "Это отдельное локальное демо, без учётной записи и сервера Кизуны.\nНажмите «Обновить приложение» в плашке.\nПосле скрытия плашки или отмены можно проверить обновление снова.")
            let check = NSButton(title: "Проверить обновление снова", target: self, action: #selector(checkAgain))
            let content = NSStackView(views: [title, description, check])
            content.orientation = .vertical; content.alignment = .leading; content.spacing = 16
            content.translatesAutoresizingMaskIntoConstraints = false
            window.contentView!.addSubview(content)
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
                content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
                content.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24),
            ])
            if installed { log("INSTALLED 2") }
        }
        updates.banner.attach(to: window.contentView!)
        updates.prepareForRestart = { [weak self] reply in
            guard let self else { return }
            if self.mode == "draft" && !self.draftBlocked {
                self.draftBlocked = true; self.log("DRAFT BLOCKED"); reply("Сохраните тестовый черновик.")
            } else { self.log("READY"); reply(nil) }
        }
        window.orderFront(nil)
        if mode == "demo" { window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        if mode == "reminders" {
            reminderPolicy.postpone(version: "2", by: .hour)
            reminderDate = reminderDate.addingTimeInterval(3600)
        }
        if mode == "probe" {
            reminderPolicy.ignore(version: "2")
            UserDefaults.standard.set(Date(), forKey: "SULastCheckTime")
        }
        updates.start()
        if installed { return }
        if mode != "probe" {
            if ["success", "defer", "demo", "reminders"].contains(mode) { updates.updater.checkForUpdatesInBackground() }
            else { updates.checkForUpdates(nil) }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        if mode != "demo" { DispatchQueue.main.asyncAfter(deadline: .now() + 40) { [weak self] in self?.finish("TIMEOUT") } }
    }
    @objc func checkAgain(_ sender: Any?) { updates.checkForUpdates(sender) }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if mode == "demo" { log("DEMO CLOSED") }
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { mode == "demo" }
    func tick() {
        let banner = updates.banner, text = banner.title.stringValue
        if text != previous { previous = text; log(text) }
        if mode == "demo" { return }
        if mode == "reminders" { tickReminders(); return }
        if mode == "probe" { tickProbe(); return }
        if text.hasPrefix("Доступна Кизуна") {
            if let path = Bundle.main.object(forInfoDictionaryKey: "TestScreenshot") as? String {
                banner.layoutSubtreeIfNeeded()
                if let bitmap = banner.bitmapImageRepForCachingDisplay(in: banner.bounds) {
                    banner.cacheDisplay(in: banner.bounds, to: bitmap)
                    try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
                }
            }
            if mode == "defer" {
                banner.secondary.performClick(nil)
                if banner.isHidden { finish("DEFERRED") }
            } else { banner.primary.performClick(nil) }
        } else if text == "Скачиваем обновление…" && mode == "cancel" {
            banner.secondary.performClick(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.finish("CANCELLED") }
        } else if text == "Обновление готово" && mode == "draft" {
            log("DRAFT RETRY"); banner.primary.performClick(nil)
        } else if text == "Не удалось обновить Кизуну" {
            if ["bad-archive", "bad-feed", "network"].contains(mode) { finish("REJECTED") }
            else { finish("UNEXPECTED ERROR") }
        } else if text == "Обновлений для этого Mac нет" { finish("NO UPDATE") }
    }
    func tickProbe() {
        let updater = updates.updater, banner = updates.banner
        if banner.title.stringValue == "Не удалось обновить Кизуну" { finish("UNEXPECTED ERROR"); return }
        if reminderStep == 0 && updater.canCheckForUpdates && !updater.sessionInProgress {
            // Change a real SDK setting, then synchronously enter its asynchronous installer probe.
            updater.updateCheckInterval += 60
            updater.resetUpdateCycle()
            guard updater.sessionInProgress, !updater.canCheckForUpdates, banner.isHidden else {
                finish("UNEXPECTED ERROR: no hidden installer probe"); return
            }
            log("SDK INSTALLER PROBE ACTIVE")
            updates.checkForUpdates(nil); updates.checkForUpdates(nil)
            log("PROBE MANUAL REQUEST"); reminderStep = 1
        } else if reminderStep == 1 && !banner.isHidden && banner.title.stringValue.hasPrefix("Доступна Кизуна") {
            guard !reminderPolicy.shouldOffer(version: "2", userInitiated: false) else {
                finish("UNEXPECTED ERROR: probe check cleared ignore before acceptance"); return
            }
            log("PROBE MANUAL BYPASS")
            banner.primary.performClick(nil); reminderStep = 2
        }
    }
    func tickReminders() {
        let banner = updates.banner
        let offered = !banner.isHidden && banner.title.stringValue.hasPrefix("Доступна Кизуна")
        if banner.title.stringValue == "Не удалось обновить Кизуну" { finish("UNEXPECTED ERROR"); return }
        switch reminderStep {
        case 0 where offered:
            guard !banner.close.isHidden, !banner.tertiary.isHidden,
                  banner.secondary.title == "Отложить на 1 час" else { finish("UNEXPECTED ERROR: reminder controls"); return }
            let due = reminderPolicy.pending
            guard updates.updater.sessionInProgress else { finish("UNEXPECTED ERROR: no active SDK session"); return }
            reminderFirings.last?()
            guard reminderPolicy.pending == due, reminderDelays.last == 15 else {
                finish("UNEXPECTED ERROR: due reminder lost while SDK busy"); return
            }
            log("DUE REMINDER BUSY RETRY")
            banner.secondary.performClick(nil); banner.secondary.performClick(nil)
            guard reminderPolicy.pending?.deadline == reminderDate.addingTimeInterval(3600), banner.isHidden else {
                finish("UNEXPECTED ERROR: hour decision"); return
            }
            log("SNOOZED 1H"); reminderStep = 1
        case 1 where updates.updater.canCheckForUpdates && !updates.updater.sessionInProgress:
            updates.updater.checkForUpdatesInBackground()
            reminderCheckAfter = Date().addingTimeInterval(0.5); reminderStep = 2
        case 2 where Date() >= reminderCheckAfter && updates.updater.canCheckForUpdates && !updates.updater.sessionInProgress:
            guard banner.isHidden else { finish("UNEXPECTED ERROR: snooze suppression"); return }
            log("SNOOZE BACKGROUND SUPPRESSED")
            updates.checkForUpdates(nil); reminderStep = 3
        case 3 where offered:
            guard reminderPolicy.pending?.deadline == reminderDate.addingTimeInterval(3600) else {
                finish("UNEXPECTED ERROR: manual moved deadline"); return
            }
            banner.close.performClick(nil); banner.tertiary.performClick(nil)
            let local = Calendar.current
            let tomorrow = local.date(byAdding: .day, value: 1, to: local.startOfDay(for: reminderDate))
            guard reminderPolicy.pending?.deadline == tomorrow else { finish("UNEXPECTED ERROR: tomorrow decision"); return }
            log("CLOSED UNTIL TOMORROW")
            guard banner.isHidden, updates.updater.sessionInProgress else {
                finish("UNEXPECTED ERROR: expected hidden active SDK session after close"); return
            }
            updates.checkForUpdates(nil); updates.checkForUpdates(nil)
            log("EARLY MANUAL REQUEST"); reminderStep = 4
        case 4 where offered:
            let local = Calendar.current
            let tomorrow = local.date(byAdding: .day, value: 1, to: local.startOfDay(for: reminderDate))
            guard reminderPolicy.pending?.deadline == tomorrow else { finish("UNEXPECTED ERROR: early manual moved deadline"); return }
            log("EARLY MANUAL BYPASS")
            banner.close.performClick(nil); reminderStep = 10
        case 10 where updates.updater.canCheckForUpdates && !updates.updater.sessionInProgress:
            guard let pending = reminderPolicy.pending else { finish("UNEXPECTED ERROR: missing tomorrow reminder"); return }
            reminderDate = pending.deadline.addingTimeInterval(1)
            reminderFirings.last?()
            guard reminderPolicy.pending == nil else { finish("UNEXPECTED ERROR: due reminder not consumed"); return }
            log("DUE REMINDER CHECKED"); reminderStep = 5
        case 5 where offered:
            banner.tertiary.performClick(nil); banner.close.performClick(nil)
            guard reminderPolicy.pending == nil,
                  !reminderPolicy.shouldOffer(version: "2", userInitiated: false) else {
                finish("UNEXPECTED ERROR: ignore decision"); return
            }
            log("IGNORED CURRENT BUILD"); reminderStep = 6
        case 6 where updates.updater.canCheckForUpdates && !updates.updater.sessionInProgress:
            updates.updater.checkForUpdatesInBackground()
            reminderCheckAfter = Date().addingTimeInterval(0.5); reminderStep = 7
        case 7 where Date() >= reminderCheckAfter && updates.updater.canCheckForUpdates && !updates.updater.sessionInProgress:
            guard banner.isHidden else { finish("UNEXPECTED ERROR: ignore suppression"); return }
            log("IGNORE BACKGROUND SUPPRESSED")
            updates.checkForUpdates(nil); reminderStep = 8
        case 8 where offered:
            for fire in reminderFirings { fire() }
            guard !banner.isHidden else { finish("UNEXPECTED ERROR: stale reminder callback"); return }
            log("MANUAL BYPASS")
            banner.primary.performClick(nil); banner.primary.performClick(nil)
            guard reminderPolicy.shouldOffer(version: "2", userInitiated: false) else {
                finish("UNEXPECTED ERROR: install did not clear ignore"); return
            }
            reminderStep = 9
        case 9:
            if !offered {
                guard banner.close.isHidden, banner.tertiary.isHidden else { finish("UNEXPECTED ERROR: extra controls during download"); return }
            }
        default: break
        }
    }
}
