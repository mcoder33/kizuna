import AppKit
import Sparkle

/// Native UI stays available even when the website is offline. Sparkle owns
/// version selection, signature verification, replacement and relaunch.
@MainActor
final class DesktopUpdates: NSObject, SPUUserDriver, SPUUpdaterDelegate {
    let banner = UpdateBanner()
    var prepareForRestart: (@escaping (String?) -> Void) -> Void = { $0(nil) }
    var resumeEditing: () -> Void = {}
    var showWindow: () -> Void = {}
    private(set) var isInstalling = false
    private(set) lazy var updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: self, delegate: self)
    private var installRequested = false
    private var preserveMessage = false
    private var received: UInt64 = 0
    private var expected: UInt64 = 0
    private var generation = 0
    private var deferInstallation: (() -> Void)?
    private var manualCheckPending = false
    private var readinessObservations: [NSKeyValueObservation] = []
    private let reminderPolicy: UpdateReminderPolicy
    private let scheduleReminder: UpdateReminderController.Schedule
    private lazy var reminders = UpdateReminderController(policy: reminderPolicy,
        canCheck: { [weak self] in self?.updater.canCheckForUpdates == true && self?.updater.sessionInProgress == false },
        check: { [weak self] in self?.updater.checkForUpdatesInBackground() }, schedule: scheduleReminder)

    init(reminderPolicy: UpdateReminderPolicy = UpdateReminderPolicy(),
         scheduleReminder: @escaping UpdateReminderController.Schedule = UpdateReminderController.scheduleTimer) {
        self.reminderPolicy = reminderPolicy; self.scheduleReminder = scheduleReminder
        super.init()
    }

    func refreshLocale() { banner.refreshLocale() }

    func start() {
        readinessObservations = [
            updater.observe(\.sessionInProgress, options: [.new]) { [weak self] _, change in
                guard change.newValue == false else { return }
                Task { @MainActor in self?.performPendingManualCheckIfReady() }
            },
            updater.observe(\.canCheckForUpdates, options: [.new]) { [weak self] _, change in
                guard change.newValue == true else { return }
                Task { @MainActor in self?.performPendingManualCheckIfReady() }
            },
        ]
        do { try updater.start(); reminders.refresh() }
        catch { showFailure(error) }
    }

    @objc func checkForUpdates(_ sender: Any?) {
        showWindow()
        if updater.sessionInProgress && banner.isHidden {
            manualCheckPending = true
            return
        }
        if updater.canCheckForUpdates { updater.checkForUpdates() }
        else { showUpdateInFocus() }
    }

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        // Defaults explicitly enable checks, never unsolicited downloads.
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, automaticUpdateDownloading: false, sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        manualCheckPending = false
        preserveMessage = false
        banner.present(L("Проверяем обновления…"), detail: L("Это займёт несколько секунд."), progress: -1,
                       secondary: L("Отмена"), onSecondary: cancellation)
    }

    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        generation += 1
        let userInitiated = state.userInitiated || manualCheckPending
        manualCheckPending = false
        preserveMessage = false
        installRequested = false
        deferInstallation = { reply(.dismiss) }
        if appcastItem.isInformationOnlyUpdate {
            banner.present(L("Доступна новая версия"), detail: L("Для этой версии нужна отдельная установка."),
                           primary: L("Подробнее"), onPrimary: { [weak self] in
                if let url = appcastItem.infoURL, url.scheme == "https" { NSWorkspace.shared.open(url) }
                self?.banner.isHidden = true; reply(.dismiss)
            }, secondary: L("Позже"), onSecondary: { reply(.dismiss) })
            return
        }
        if state.stage == .notDownloaded {
            let version = appcastItem.versionString
            guard reminderPolicy.shouldOffer(version: version, userInitiated: userInitiated) else {
                banner.isHidden = true; banner.clearActions(); deferInstallation = nil
                reply(.dismiss)
                return
            }
            reminderPolicy.observeEligibleVersion(version)
            reminders.refresh()
            let current = generation
            let respond: (SPUUserUpdateChoice) -> Void = { [weak self] choice in
                guard let self, self.generation == current else { return }
                self.generation += 1; self.banner.clearActions(); self.deferInstallation = nil
                reply(choice)
            }
            let dismiss: (UpdateReminderPolicy.Delay?) -> Void = { [weak self] delay in
                guard let self, self.generation == current else { return }
                if let delay { self.reminderPolicy.postpone(version: version, by: delay) }
                else { self.reminderPolicy.ignore(version: version) }
                self.reminders.refresh(); self.banner.isHidden = true
                respond(.dismiss)
            }
            banner.present(L("Доступна Кизуна {version}", ["version": appcastItem.displayVersionString]),
                           detail: L("Обновление установится, и приложение перезапустится."),
                           primary: L("Обновить приложение"), onPrimary: { [weak self] in
                guard let self, self.generation == current else { return }
                self.reminderPolicy.beginInstallation(version: version); self.reminders.refresh()
                self.installRequested = true; self.banner.disableActions(); respond(.install)
            }, secondary: L("Отложить на 1 час"), onSecondary: { dismiss(.hour) },
               tertiary: L("Не показывать больше"), onTertiary: { dismiss(nil) }, onClose: { dismiss(.tomorrow) })
            return
        }
        banner.present(L("Доступна Кизуна {version}", ["version": appcastItem.displayVersionString]),
                       detail: L("Обновление установится, и приложение перезапустится."),
                       primary: L("Обновить приложение"), onPrimary: { [weak self] in
            guard let self else { return }
            self.installRequested = true
            if state.stage == .installing { self.installWhenReady { reply(.install) } }
            else { self.banner.disableActions(); reply(.install) }
        }, secondary: L("Позже"), onSecondary: { reply(.dismiss) })
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}

    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        manualCheckPending = false
        // A missing applicable update can also mean a newer macOS is required.
        showMessage(L("Обновлений для этого Mac нет"), detail: L("Можно продолжать работу."))
        acknowledgement()
    }

    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        manualCheckPending = false
        showFailure(error)
        acknowledgement()
    }

    private func showFailure(_ error: Error) {
        NSLog("Kizuna updater: %@", error.localizedDescription)
        isInstalling = false; resumeEditing()
        showMessage(L("Не удалось обновить Кизуну"), detail: L("Текущая версия продолжает работать. Проверьте связь и попробуйте ещё раз."))
    }

    private func showMessage(_ title: @autoclosure @escaping () -> String, detail: @autoclosure @escaping () -> String) {
        preserveMessage = true
        banner.present(title(), detail: detail(), secondary: L("Закрыть"), onSecondary: { [weak self] in self?.banner.isHidden = true })
    }

    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        received = 0; expected = 0
        banner.present(L("Скачиваем обновление…"), detail: L("Можно продолжать работу."), progress: -1,
                       secondary: L("Отмена"), onSecondary: cancellation)
    }

    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { expected = expectedContentLength; updateProgress() }
    func showDownloadDidReceiveData(ofLength length: UInt64) { received &+= length; updateProgress() }
    private func updateProgress() {
        banner.setProgress(expected > 0 ? min(1, Double(received) / Double(expected)) : -1)
    }

    func showDownloadDidStartExtractingUpdate() {
        banner.present(L("Готовим обновление…"), detail: L("Проверяем и распаковываем новую версию."), progress: -1)
    }
    func showExtractionReceivedProgress(_ progress: Double) { banner.setProgress(progress) }

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        deferInstallation = { reply(.dismiss) }
        if installRequested { installWhenReady { reply(.install) } }
        else {
            banner.present(L("Обновление готово"), detail: L("Кизуна перезапустится после установки."),
                           primary: L("Обновить приложение"), onPrimary: { [weak self] in self?.installWhenReady { reply(.install) } },
                           secondary: L("Позже"), onSecondary: { reply(.dismiss) })
        }
    }

    private func installWhenReady(_ install: @escaping () -> Void) {
        generation += 1
        let current = generation
        banner.disableActions()
        prepareForRestart { [weak self] reason in
            guard let self, self.generation == current else { return }
            if let reason {
                self.banner.present(L("Обновление готово"), detail: reason,
                                    primary: L("Продолжить обновление"), onPrimary: { [weak self] in self?.installWhenReady(install) },
                                    secondary: L("Позже"), onSecondary: { [weak self] in self?.deferInstallation?() })
            } else {
                self.isInstalling = true
                self.banner.present(L("Устанавливаем обновление…"), detail: L("Кизуна сейчас перезапустится."), progress: -1)
                install()
            }
        }
    }

    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        banner.present(L("Устанавливаем обновление…"), detail: L("Кизуна сейчас перезапустится."), progress: -1)
        if !applicationTerminated {
            // Sparkle allows retry if macOS or the application delayed quitting.
            banner.setRetry { [weak self] in self?.installWhenReady(retryTerminatingApplication) }
        }
    }

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        // Sparkle permits a new cycle here, before its asynchronous installer
        // probe makes the updater busy again without another finish callback.
        performPendingManualCheckIfReady()
    }
    private func performPendingManualCheckIfReady() {
        guard manualCheckPending, !isInstalling, updater.canCheckForUpdates, !updater.sessionInProgress else { return }
        manualCheckPending = false
        updater.checkForUpdates()
    }

    func dismissUpdateInstallation() {
        generation += 1; installRequested = false; isInstalling = false
        deferInstallation = nil
        resumeEditing()
        if !preserveMessage { banner.isHidden = true }
        banner.clearActions()
        if preserveMessage { banner.setClose { [weak self] in self?.banner.isHidden = true } }
    }
    func showUpdateInFocus() { showWindow(); if !banner.isHidden { NSAccessibility.post(element: banner, notification: .announcementRequested, userInfo: [.announcement: banner.title.stringValue, .priority: NSAccessibilityPriorityLevel.medium.rawValue]) } }
}

@MainActor
final class UpdateBanner: NSVisualEffectView {
    let title = NSTextField(labelWithString: "")
    let detail = NSTextField(wrappingLabelWithString: "")
    let primary = NSButton(title: "", target: nil, action: nil)
    let secondary = NSButton(title: "", target: nil, action: nil)
    let tertiary = NSButton(title: "", target: nil, action: nil)
    let close = NSButton(title: "×", target: nil, action: nil)
    let progress = NSProgressIndicator()
    private var primaryAction: (() -> Void)?
    private var secondaryAction: (() -> Void)?
    private var tertiaryAction: (() -> Void)?
    private var closeAction: (() -> Void)?
    private var headingText: (() -> String)?
    private var detailText: (() -> String)?
    private var primaryText: (() -> String?)?
    private var secondaryText: (() -> String?)?
    private var tertiaryText: (() -> String?)?

    init() {
        super.init(frame: .zero)
        material = .popover; state = .active; blendingMode = .withinWindow
        wantsLayer = true; layer?.cornerRadius = 16; layer?.masksToBounds = true
        layer?.borderWidth = 0.5; layer?.borderColor = NSColor.separatorColor.cgColor
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        detail.font = .systemFont(ofSize: 12); detail.textColor = .secondaryLabelColor
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        primary.bezelStyle = .rounded; primary.controlSize = .regular
        primary.bezelColor = .systemRed
        secondary.bezelStyle = .rounded
        tertiary.bezelStyle = .inline; tertiary.controlSize = .small
        tertiary.toolTip = L("Не напоминать об этой версии. Новые версии будут показаны.")
        close.isBordered = false; close.font = .systemFont(ofSize: 18)
        close.toolTip = L("Закрыть до завтра"); close.setAccessibilityLabel(L("Закрыть до завтра"))
        primary.target = self; primary.action = #selector(accept)
        secondary.target = self; secondary.action = #selector(deferUpdate)
        tertiary.target = self; tertiary.action = #selector(ignoreUpdate)
        close.target = self; close.action = #selector(closeUpdate)
        progress.style = .bar; progress.minValue = 0; progress.maxValue = 1
        let buttons = NSStackView(views: [primary, secondary]); buttons.spacing = 8
        let heading = NSStackView(views: [title, close]); heading.spacing = 8
        let stack = NSStackView(views: [heading, detail, progress, buttons, tertiary])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false; addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16), stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 14), stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),
            heading.widthAnchor.constraint(equalTo: stack.widthAnchor),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor), progress.widthAnchor.constraint(equalTo: stack.widthAnchor),
            close.widthAnchor.constraint(equalToConstant: 24), close.heightAnchor.constraint(equalToConstant: 24)
        ])
        isHidden = true; setAccessibilityLabel(L("Обновление Кизуны"))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func attach(to container: NSView) {
        translatesAutoresizingMaskIntoConstraints = false; container.addSubview(self)
        NSLayoutConstraint.activate([
            trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -18), topAnchor.constraint(equalTo: container.topAnchor, constant: 14),
            widthAnchor.constraint(equalToConstant: 480), leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 18)
        ])
    }
    func present(_ heading: @autoclosure @escaping () -> String, detail text: @autoclosure @escaping () -> String, progress fraction: Double? = nil,
                 primary primaryTitle: @autoclosure @escaping () -> String? = nil, onPrimary: (() -> Void)? = nil,
                 secondary secondaryTitle: @autoclosure @escaping () -> String? = nil, onSecondary: (() -> Void)? = nil,
                 tertiary tertiaryTitle: @autoclosure @escaping () -> String? = nil, onTertiary: (() -> Void)? = nil, onClose: (() -> Void)? = nil) {
        clearActions()
        headingText = heading; detailText = text
        primaryText = primaryTitle; secondaryText = secondaryTitle; tertiaryText = tertiaryTitle
        refreshLocale()
        primary.isHidden = primaryTitle() == nil; primary.isEnabled = true
        secondary.isHidden = secondaryTitle() == nil; secondary.isEnabled = true
        tertiary.isHidden = tertiaryTitle() == nil; tertiary.isEnabled = true
        close.isHidden = onClose == nil; close.isEnabled = true
        primaryAction = onPrimary; secondaryAction = onSecondary; tertiaryAction = onTertiary; closeAction = onClose
        progress.isHidden = fraction == nil
        if let fraction { setProgress(fraction) } else { progress.stopAnimation(nil) }
        isHidden = false
    }
    // Refresh text only: callbacks, readiness, progress and Sparkle state stay intact.
    func refreshLocale() {
        if let headingText { title.stringValue = headingText() }
        if let detailText { detail.stringValue = detailText() }
        if let primaryText { primary.title = primaryText() ?? "" }
        if let secondaryText { secondary.title = secondaryText() ?? "" }
        if let tertiaryText { tertiary.title = tertiaryText() ?? "" }
        tertiary.toolTip = L("Не напоминать об этой версии. Новые версии будут показаны.")
        close.toolTip = L("Закрыть до завтра"); close.setAccessibilityLabel(L("Закрыть до завтра"))
        setAccessibilityLabel(L("Обновление Кизуны"))
    }
    func setProgress(_ fraction: Double) {
        progress.isIndeterminate = fraction < 0
        if fraction < 0 { progress.startAnimation(nil) }
        else { progress.stopAnimation(nil); progress.doubleValue = min(1, max(0, fraction)) }
    }
    func disableActions() { clearActions(); primary.isEnabled = false; secondary.isEnabled = false; tertiary.isEnabled = false; close.isEnabled = false }
    func clearActions() { primaryAction = nil; secondaryAction = nil; tertiaryAction = nil; closeAction = nil }
    func setClose(_ action: @escaping () -> Void) { secondaryText = { L("Закрыть") }; refreshLocale(); secondary.isHidden = false; secondary.isEnabled = true; secondaryAction = action }
    func setRetry(_ action: @escaping () -> Void) { primaryText = { L("Перезапустить") }; refreshLocale(); primary.isHidden = false; primary.isEnabled = true; primaryAction = action }
    @objc private func accept() { let action = primaryAction; clearActions(); action?() }
    @objc private func deferUpdate() { let action = secondaryAction; clearActions(); action?() }
    @objc private func ignoreUpdate() { let action = tertiaryAction; clearActions(); action?() }
    @objc private func closeUpdate() { let action = closeAction; clearActions(); action?() }
}
