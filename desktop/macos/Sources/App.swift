import AppKit
import WebKit
import Carbon

@main
enum KizunaMain {
    static func main() {
        if CommandLine.arguments.contains("--self-test") {
            DesktopOrigin.selfTest()
            QuickCapturePolicy.selfTest()
            DesktopLocale.selfTest()
            KizunaIcon.selfTest()
            return
        }
        let application = NSApplication.shared
        let delegate = KizunaAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor
final class KizunaAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    static weak var shared: KizunaAppDelegate?
    private let origin = DesktopOrigin.configured(ProcessInfo.processInfo.environment["KIZUNA_URL"])
    private var window: NSWindow!
    private var webView: WKWebView!
    private var navigation: DesktopNavigation!
    private var notifications: DesktopNotifications!
    private var quickCapturePanel: DesktopQuickCapture!
    private var updates: DesktopUpdates!
    private var restartPrepared = false
    private var timeZoneObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?
    private var displayedLocale = DesktopLocale.current
    private var statusItem: NSStatusItem!
    private var hotKey: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
    private var localCaptureShortcut: Any?
    private var errorView: NSView!
    private var errorText: NSTextField!
    private var capturePending = false
    private var pendingDestination: URL?
    private var captureAttempt = 0
    private var captureGeneration = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.shared = self
        makeMenus()
        makeWindow()
        timeZoneObserver = NotificationCenter.default.addObserver(forName: .NSSystemTimeZoneDidChange, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.refreshSystemTimeZone() } }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.refreshAfterResume() } }
        quickCapturePanel = DesktopQuickCapture(webView: webView, origin: origin)
        quickCapturePanel.onLogin = { [weak self] in
            guard let self else { return }
            self.showWindow(nil)
            if self.webView.url?.path != "/login" {
                self.webView.load(URLRequest(url: self.origin.appendingPathComponent("login")))
            }
        }
        makeStatusItem()
        registerCaptureShortcut()
        notifications = DesktopNotifications(webView: webView, origin: origin)
        notifications.onOpen = { [weak self] url in
            guard let self, DesktopOrigin.contains(url, origin: self.origin) else { return }
            self.openNotification(url)
        }
        notifications.start()
        updates = DesktopUpdates()
        updates.banner.attach(to: window.contentView!)
        updates.showWindow = { [weak self] in self?.showWindow(nil) }
        updates.prepareForRestart = { [weak self] reply in self?.prepareForUpdate(reply) }
        updates.resumeEditing = { [weak self] in
            self?.restartPrepared = false
            self?.webView.evaluateJavaScript("window.KizunaUpdateGuard?.resume()", completionHandler: nil)
        }
        updates.start()
        webView.load(URLRequest(url: origin.appendingPathComponent("login")))
        showWindow(nil)
    }

    private func refreshSystemTimeZone() {
        guard let webView, let url = webView.url, DesktopOrigin.contains(url, origin: origin) else { return }
        webView.evaluateJavaScript(DesktopTimeZone.script(), completionHandler: nil)
    }

    func applicationDidBecomeActive(_ notification: Notification) { refreshAfterResume() }

    private func refreshAfterResume() {
        notifications?.refresh()
        guard let webView, let url = webView.url, DesktopOrigin.contains(url, origin: origin) else { return }
        refreshSystemTimeZone()
        webView.evaluateJavaScript("window.dispatchEvent(new Event('pagent:resume'));", completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "kizunaCaptureAppearance" {
            guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
                  DesktopOrigin.contains(url, origin: origin), let snapshot = message.body as? [String: Any],
                  let value = CaptureAppearance.read(snapshot) else { return }
            quickCapturePanel?.syncAppearance(snapshot)
            window?.appearance = value.windowAppearance
            return
        }
        if message.name == "kizunaNotifications" {
            guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
                  DesktopOrigin.contains(url, origin: origin), let action = message.body as? String else { return }
            switch action {
            case "enable": notifications?.requestAuthorization()
            case "disable": notifications?.disable()
            case "test": notifications?.sendTest()
            case "status": notifications?.publishAuthorization()
            default: break
            }
            return
        }
        if message.name == "kizunaTimeZoneDetection" {
            guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, DesktopOrigin.contains(url, origin: origin) else { return }
            refreshSystemTimeZone()
            return
        }
        guard message.name == "kizunaLocale", message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url, DesktopOrigin.contains(url, origin: origin),
              let snapshot = message.body as? [String: Any],
              let requested = snapshot["requestedLocale"] as? String,
              requested == "system" || DesktopLocale.supported.contains(requested) else { return }
        let detected = snapshot["detectedLocale"] as? String
        guard snapshot["detectedLocale"] == nil || snapshot["detectedLocale"] is NSNull || (detected != nil && DesktopLocale.supported.contains(detected!)) else { return }
        DesktopLocale.requested = requested
        DesktopLocale.detected = detected
        guard displayedLocale != DesktopLocale.current else { return }
        displayedLocale = DesktopLocale.current
        window?.title = L("Кизуна")
        makeMenus()
        quickCapturePanel?.refreshLocale()
        updates?.refreshLocale()
        if let container = window?.contentView {
            let wasVisible = errorView?.isHidden == false
            errorView?.removeFromSuperview()
            makeErrorView(in: container)
            errorView.isHidden = !wasVisible
            errorText.stringValue = L("Проверьте подключение к интернету и попробуйте ещё раз.\nВаши записи остаются на сервере.")
        }
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem); makeStatusItem() }
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = L("Кизуна"); window.minSize = NSSize(width: 760, height: 560)
        window.setFrameAutosaveName("KizunaMainWindow"); window.center(); window.delegate = self
        window.isReleasedWhenClosed = false
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController.add(self, name: "kizunaLocale")
        configuration.userContentController.add(self, name: "kizunaCaptureAppearance")
        configuration.userContentController.add(self, name: "kizunaTimeZoneDetection")
        configuration.userContentController.add(self, name: "kizunaNotifications")
        let originString = String(data: try! JSONEncoder().encode(origin.absoluteString), encoding: .utf8)!
        let detectionScript = "if (window.location.origin === new URL(\(originString)).origin) { \(DesktopTimeZone.script()) window.webkit.messageHandlers.kizunaTimeZoneDetection.postMessage({}); }"
        configuration.userContentController.addUserScript(WKUserScript(source:detectionScript,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        let localeBridge = """
        (() => {
          let generation = 0;
          async function sync() {
            const requestGeneration = ++generation;
            try {
              const response = await fetch('/api/settings', {credentials:'same-origin', cache:'no-store'});
              if (requestGeneration !== generation) return;
              if (!response.ok) { window.webkit.messageHandlers.kizunaLocale.postMessage({requestedLocale:'system',detectedLocale:null}); return; }
              const data = await response.json();
              if (requestGeneration !== generation) return;
              window.webkit.messageHandlers.kizunaLocale.postMessage({requestedLocale:data.settings?.locale || 'system',detectedLocale:data.settings?.detectedLocale || null});
            } catch {}
          }
          sync(); window.addEventListener('pagent:localesaved', sync);
          window.addEventListener('pagent:timezonesaved', sync);
          window.addEventListener('focus', sync);
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: localeBridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        if let scriptURL = Bundle.main.url(forResource: "CaptureAppearance", withExtension: "js"),
           let script = try? String(contentsOf: scriptURL, encoding: .utf8) {
            let trustedScript = "if (window.location.origin === new URL(\(originString)).origin) { \(script) }"
            configuration.userContentController.addUserScript(WKUserScript(source: trustedScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        if let scriptURL = Bundle.main.url(forResource: "RestartGuard", withExtension: "js"),
           let script = try? String(contentsOf: scriptURL, encoding: .utf8) {
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.customUserAgent = nil
        navigation = DesktopNavigation(origin: origin); navigation.window = window
        navigation.onStart = { [weak self] in self?.errorView.isHidden = true }
        navigation.onLoad = { [weak self] in
            guard let self else { return }
            self.errorView.isHidden = true
            self.notifications?.refresh()
            if self.webView.url?.path == "/" { self.quickCapturePanel?.resumeAfterLogin() }
            if self.capturePending || self.pendingDestination != nil { self.beginCaptureFocus() }
        }
        navigation.onFailure = { [weak self] _ in
            guard let self else { return }
            self.errorText.stringValue = L("Проверьте подключение к интернету и попробуйте ещё раз.\nВаши записи остаются на сервере.")
            self.errorView.isHidden = false
        }
        webView.navigationDelegate = navigation; webView.uiDelegate = navigation
        let container = NSView(); window.contentView = container
        webView.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor), webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor), webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        makeErrorView(in: container)
    }

    private func makeErrorView(in container: NSView) {
        let backdrop = NSVisualEffectView(); backdrop.material = .windowBackground; backdrop.blendingMode = .withinWindow
        backdrop.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(backdrop); errorView = backdrop
        NSLayoutConstraint.activate([
            backdrop.leadingAnchor.constraint(equalTo: container.leadingAnchor), backdrop.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            backdrop.topAnchor.constraint(equalTo: container.topAnchor), backdrop.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        let title = NSTextField(labelWithString: L("Кизуна пока недоступна"))
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        errorText = NSTextField(wrappingLabelWithString: L("Проверьте подключение к интернету."))
        errorText.alignment = .center; errorText.textColor = .secondaryLabelColor
        let retry = NSButton(title: L("Попробовать снова"), target: self, action: #selector(reload(_:)))
        retry.bezelStyle = .rounded; retry.keyEquivalent = "\r"
        let browser = NSButton(title: L("Открыть в браузере"), target: self, action: #selector(openInBrowser(_:)))
        browser.bezelStyle = .rounded
        let stack = NSStackView(views: [title, errorText, retry, browser]); stack.orientation = .vertical; stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false; backdrop.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: backdrop.centerXAnchor),
                                     stack.centerYAnchor.constraint(equalTo: backdrop.centerYAnchor), stack.widthAnchor.constraint(lessThanOrEqualToConstant: 480)])
        backdrop.isHidden = true
    }

    private func makeMenus() {
        let bar = NSMenu(); NSApp.mainMenu = bar
        let app = NSMenu(); addMenu(L("Кизуна"), menu: app, to: bar)
        addItem(L("О Кизуне"), action: #selector(about(_:)), to: app)
        addItem(L("Проверить обновления…"), action: #selector(checkForUpdates(_:)), to: app)
        app.addItem(.separator())
        addItem(L("Включить уведомления…"), action: #selector(enableNotifications(_:)), to: app)
        addItem(L("Новая запись"), action: #selector(quickCapture(_:)), key: "n", to: app)
        app.addItem(.separator())
        addItem(L("Скрыть Кизуну"), action: #selector(NSApplication.hide(_:)), key: "h", target: NSApp, to: app)
        addItem(L("Завершить Кизуну"), action: #selector(NSApplication.terminate(_:)), key: "q", target: NSApp, to: app)
        let edit = NSMenu(); addMenu(L("Правка"), menu: edit, to: bar)
        for (title, selector, key) in [(L("Отменить"), "undo:", "z"), (L("Вырезать"), "cut:", "x"),
                                       (L("Копировать"), "copy:", "c"), (L("Вставить"), "paste:", "v"), (L("Выбрать всё"), "selectAll:", "a")] {
            let item = NSMenuItem(title: title, action: Selector(selector), keyEquivalent: key); edit.addItem(item)
        }
        let redo = NSMenuItem(title: L("Повторить"), action: NSSelectorFromString("redo:"), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]; edit.insertItem(redo, at: 1)
        let view = NSMenu(); addMenu(L("Вид"), menu: view, to: bar)
        addItem(L("Обновить"), action: #selector(reload(_:)), key: "r", to: view)
        addItem(L("Открыть в браузере"), action: #selector(openInBrowser(_:)), key: "l", to: view)
        let windows = NSMenu(); addMenu(L("Окно"), menu: windows, to: bar); NSApp.windowsMenu = windows
        addItem(L("Показать Кизуну"), action: #selector(showWindow(_:)), key: "0", to: windows)
        addItem(L("Свернуть"), action: #selector(NSWindow.performMiniaturize(_:)), key: "m", target: nil, to: windows)
        addItem(L("Закрыть окно"), action: #selector(NSWindow.performClose(_:)), key: "w", target: nil, to: windows)
    }
    private func addMenu(_ title: String, menu: NSMenu, to parent: NSMenu) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); menu.title = title; item.submenu = menu; parent.addItem(item)
    }
    private func addItem(_ title: String, action: Selector, key: String = "", target: AnyObject? = nil, to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = target ?? (action == #selector(NSWindow.performMiniaturize(_:)) || action == #selector(NSWindow.performClose(_:)) ? nil : self)
        menu.addItem(item)
    }
    private func makeStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = KizunaIcon.menuBarTemplate(size: 18)
        statusItem.button?.setAccessibilityLabel(L("Кизуна"))
        let menu = NSMenu()
        addItem(L("Новая запись  ⌘⇧Пробел"), action: #selector(quickCapture(_:)), to: menu)
        addItem(L("Показать Кизуну"), action: #selector(showWindow(_:)), to: menu)
        addItem(L("Проверить обновления…"), action: #selector(checkForUpdates(_:)), to: menu)
        addItem(L("Включить уведомления…"), action: #selector(enableNotifications(_:)), to: menu)
        menu.addItem(.separator())
        addItem(L("Завершить Кизуну"), action: #selector(NSApplication.terminate(_:)), target: NSApp, to: menu)
        statusItem.menu = menu
    }

    private func registerCaptureShortcut() {
        // AppKit-targeted synthetic/accessibility key events may bypass the
        // WindowServer's Carbon hotkey dispatch. Keep an in-app fallback too.
        localCaptureShortcut = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
            guard event.keyCode == UInt16(kVK_Space), modifiers == [.command, .shift] else { return event }
            self?.quickCapture(nil)
            return nil
        }
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            if ProcessInfo.processInfo.environment["KIZUNA_DEBUG_HOTKEY"] == "1" { fputs("Kizuna hotkey: Carbon event received\n", stderr) }
            DispatchQueue.main.async { KizunaAppDelegate.shared?.quickCapture(nil) }
            return noErr
        }, 1, &event, nil, &hotKeyHandler)
        if ProcessInfo.processInfo.environment["KIZUNA_DEBUG_HOTKEY"] == "1" { fputs("Kizuna hotkey: InstallEventHandler status=\(installed)\n", stderr) }
        guard installed == noErr else { return }
        let identifier = EventHotKeyID(signature: 0x4B495A55, id: 1)
        let result = RegisterEventHotKey(UInt32(kVK_Space), UInt32(cmdKey | shiftKey), identifier,
                                        GetApplicationEventTarget(), 0, &hotKey)
        if ProcessInfo.processInfo.environment["KIZUNA_DEBUG_HOTKEY"] == "1" { fputs("Kizuna hotkey: RegisterEventHotKey status=\(result), keyCode=\(kVK_Space), modifiers=\(cmdKey | shiftKey)\n", stderr) }
        if result != noErr {
            let item = NSMenuItem(title: L("⌘⇧Пробел занят — используйте меню «Новая запись»"), action: nil, keyEquivalent: "")
            statusItem.menu?.insertItem(item, at: 0)
        }
    }

    @objc func showWindow(_ sender: Any?) {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc func quickCapture(_ sender: Any?) {
        guard !restartPrepared else { return }
        quickCapturePanel.show()
    }
    private func openNotification(_ url: URL) {
        guard !restartPrepared else { return }
        capturePending = false; pendingDestination = url; showWindow(nil)
        if url.path != "/" && !url.path.isEmpty {
            pendingDestination = nil; webView.load(URLRequest(url: url)); return
        }
        guard let current = webView.url, DesktopOrigin.contains(current, origin: origin) else {
            webView.load(URLRequest(url: origin.appendingPathComponent("login"))); return
        }
        // Keep a login form and its typed credentials intact. didFinish on the
        // authenticated root applies the destination after the normal login.
        if current.path == "/login" { return }
        if current.path == "/" { beginCaptureFocus() }
        else { webView.load(URLRequest(url: origin)) }
    }
    private func beginCaptureFocus() {
        captureGeneration += 1; captureAttempt = 0; tryCaptureFocus(generation: captureGeneration)
    }
    private func tryCaptureFocus(generation: Int) {
        guard capturePending || pendingDestination != nil, generation == captureGeneration, let current = webView.url,
              DesktopOrigin.contains(current, origin: origin), current.path == "/" else { return }
        captureAttempt += 1
        let isNotification = pendingDestination != nil
        let fragment = pendingDestination?.fragment ?? "today"
        let encodedFragment = String(data: try! JSONSerialization.data(withJSONObject: [fragment]), encoding: .utf8)!
        let script = isNotification ? """
        (() => {
          if (!document.querySelector('#capture-input')) return false;
          location.hash = \(encodedFragment)[0]; return true;
        })()
        """ : """
        (() => {
          location.hash = '#today';
          const input = document.querySelector('#capture-input');
          if (!input || !input.isContentEditable || input.getClientRects().length === 0) return false;
          input.focus(); return document.activeElement === input;
        })()
        """
        webView.evaluateJavaScript(script) { [weak self] result, _ in
            guard let self, generation == self.captureGeneration else { return }
            if result as? Bool == true {
                self.capturePending = false; self.pendingDestination = nil
                self.window.makeFirstResponder(self.webView)
            }
            else if self.captureAttempt < 40 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.tryCaptureFocus(generation: generation) }
            }
        }
    }
    @objc private func reload(_ sender: Any?) {
        guard !restartPrepared else { return }
        errorView.isHidden = true
        let url = webView.url.flatMap { DesktopOrigin.contains($0, origin: origin) ? $0 : nil } ?? origin
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }
    @objc private func openInBrowser(_ sender: Any?) {
        let url = webView.url.flatMap { DesktopOrigin.contains($0, origin: origin) ? $0 : nil } ?? origin
        NSWorkspace.shared.open(url)
    }
    @objc private func enableNotifications(_ sender: Any?) { notifications.requestAuthorization() }
    @objc private func checkForUpdates(_ sender: Any?) { updates?.checkForUpdates(sender) }

    private func prepareForUpdate(_ reply: @escaping (String?) -> Void) {
        if quickCapturePanel.preventsRestart {
            reply(L("Сохраните быструю запись (⌘⇧Пробел) или дождитесь её отправки, затем продолжите обновление."))
            return
        }
        if webView.isLoading { reply(L("Дождитесь загрузки страницы и продолжите обновление.")); return }
        // A failed initial navigation has no page or draft to preserve.
        if webView.url == nil { restartPrepared = true; quickCapturePanel.hideForRestart(); reply(nil); return }
        guard let url = webView.url, DesktopOrigin.contains(url, origin: origin) else {
            reply(L("Вернитесь в Кизуну и продолжите обновление.")); return
        }
        guard let script = DesktopRestartScript.prepare(fallbackMessage: L("Завершите редактирование и перезагрузите страницу перед обновлением.")) else {
            reply(L("Не удалось проверить незавершённый ввод. Попробуйте обновление ещё раз.")); return
        }
        webView.evaluateJavaScript(script) { [weak self] result, error in
            guard let self else { return }
            guard error == nil, let json = result as? String, let data = json.data(using: .utf8),
                  let status = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                reply(L("Не удалось проверить незавершённый ввод. Попробуйте обновление ещё раз.")); return
            }
            let reason = status["reason"] as? String
            // Native quick capture may have opened while WebKit answered.
            if reason == nil && self.quickCapturePanel.preventsRestart {
                self.webView.evaluateJavaScript("window.KizunaUpdateGuard?.resume()", completionHandler: nil)
                reply(L("Сначала сохраните быструю запись (⌘⇧Пробел).")); return
            }
            self.restartPrepared = reason == nil
            if self.restartPrepared { self.quickCapturePanel.hideForRestart() }
            reply(reason)
        }
    }
    @objc private func about(_ sender: Any?) {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: L("Кизуна"), .credits: NSAttributedString(string:
            L("⌘⇧Пробел — новая запись из любого приложения.\nУведомления приходят, пока Кизуна запущена.\nДля работы требуется интернет."))])
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) {
        notifications?.stop()
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
        if let localCaptureShortcut { NSEvent.removeMonitor(localCaptureShortcut) }
    }
}
