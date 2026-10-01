import AppKit
import WebKit
import Carbon

@main
enum KizunaMain {
    static func main() {
        if CommandLine.arguments.contains("--self-test") {
            DesktopOrigin.selfTest()
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
final class KizunaAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    static weak var shared: KizunaAppDelegate?
    private let origin = DesktopOrigin.configured(ProcessInfo.processInfo.environment["KIZUNA_URL"])
    private var window: NSWindow!
    private var webView: WKWebView!
    private var navigation: DesktopNavigation!
    private var notifications: DesktopNotifications!
    private var statusItem: NSStatusItem!
    private var hotKey: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
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
        makeStatusItem()
        registerCaptureShortcut()
        notifications = DesktopNotifications(webView: webView, origin: origin)
        notifications.onOpen = { [weak self] url in
            guard let self, DesktopOrigin.contains(url, origin: self.origin) else { return }
            self.openNotification(url)
        }
        notifications.start()
        webView.load(URLRequest(url: origin.appendingPathComponent("login")))
        showWindow(nil)
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Кизуна"; window.minSize = NSSize(width: 760, height: 560)
        window.setFrameAutosaveName("KizunaMainWindow"); window.center(); window.delegate = self
        window.isReleasedWhenClosed = false
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.customUserAgent = nil
        navigation = DesktopNavigation(origin: origin); navigation.window = window
        navigation.onStart = { [weak self] in self?.errorView.isHidden = true }
        navigation.onLoad = { [weak self] in
            guard let self else { return }
            self.errorView.isHidden = true
            if self.capturePending || self.pendingDestination != nil { self.beginCaptureFocus() }
        }
        navigation.onFailure = { [weak self] _ in
            guard let self else { return }
            self.errorText.stringValue = "Проверьте подключение к интернету и попробуйте ещё раз.\nВаши записи остаются на сервере."
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
        let title = NSTextField(labelWithString: "Кизуна пока недоступна")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        errorText = NSTextField(wrappingLabelWithString: "Проверьте подключение к интернету.")
        errorText.alignment = .center; errorText.textColor = .secondaryLabelColor
        let retry = NSButton(title: "Попробовать снова", target: self, action: #selector(reload(_:)))
        retry.bezelStyle = .rounded; retry.keyEquivalent = "\r"
        let browser = NSButton(title: "Открыть в браузере", target: self, action: #selector(openInBrowser(_:)))
        browser.bezelStyle = .rounded
        let stack = NSStackView(views: [title, errorText, retry, browser]); stack.orientation = .vertical; stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false; backdrop.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: backdrop.centerXAnchor),
                                     stack.centerYAnchor.constraint(equalTo: backdrop.centerYAnchor), stack.widthAnchor.constraint(lessThanOrEqualToConstant: 480)])
        backdrop.isHidden = true
    }

    private func makeMenus() {
        let bar = NSMenu(); NSApp.mainMenu = bar
        let app = NSMenu(); addMenu("Кизуна", menu: app, to: bar)
        addItem("О Кизуне", action: #selector(about(_:)), to: app)
        app.addItem(.separator())
        addItem("Включить уведомления…", action: #selector(enableNotifications(_:)), to: app)
        addItem("Новая запись", action: #selector(quickCapture(_:)), key: "n", to: app)
        app.addItem(.separator())
        addItem("Скрыть Кизуну", action: #selector(NSApplication.hide(_:)), key: "h", target: NSApp, to: app)
        addItem("Завершить Кизуну", action: #selector(NSApplication.terminate(_:)), key: "q", target: NSApp, to: app)
        let edit = NSMenu(); addMenu("Правка", menu: edit, to: bar)
        for (title, selector, key) in [("Отменить", "undo:", "z"), ("Вырезать", "cut:", "x"),
                                       ("Копировать", "copy:", "c"), ("Вставить", "paste:", "v"), ("Выбрать всё", "selectAll:", "a")] {
            let item = NSMenuItem(title: title, action: Selector(selector), keyEquivalent: key); edit.addItem(item)
        }
        let redo = NSMenuItem(title: "Повторить", action: NSSelectorFromString("redo:"), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]; edit.insertItem(redo, at: 1)
        let view = NSMenu(); addMenu("Вид", menu: view, to: bar)
        addItem("Обновить", action: #selector(reload(_:)), key: "r", to: view)
        addItem("Открыть в браузере", action: #selector(openInBrowser(_:)), key: "l", to: view)
        let windows = NSMenu(); addMenu("Окно", menu: windows, to: bar); NSApp.windowsMenu = windows
        addItem("Показать Кизуну", action: #selector(showWindow(_:)), key: "0", to: windows)
        addItem("Свернуть", action: #selector(NSWindow.performMiniaturize(_:)), key: "m", target: nil, to: windows)
        addItem("Закрыть окно", action: #selector(NSWindow.performClose(_:)), key: "w", target: nil, to: windows)
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
        statusItem.button?.image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Кизуна")
        let menu = NSMenu()
        addItem("Новая запись  ⌘⇧Пробел", action: #selector(quickCapture(_:)), to: menu)
        addItem("Показать Кизуну", action: #selector(showWindow(_:)), to: menu)
        addItem("Включить уведомления…", action: #selector(enableNotifications(_:)), to: menu)
        menu.addItem(.separator())
        addItem("Завершить Кизуну", action: #selector(NSApplication.terminate(_:)), target: NSApp, to: menu)
        statusItem.menu = menu
    }

    private func registerCaptureShortcut() {
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { KizunaAppDelegate.shared?.quickCapture(nil) }
            return noErr
        }, 1, &event, nil, &hotKeyHandler)
        guard installed == noErr else { return }
        let identifier = EventHotKeyID(signature: 0x4B495A55, id: 1)
        let result = RegisterEventHotKey(UInt32(kVK_Space), UInt32(cmdKey | shiftKey), identifier,
                                        GetApplicationEventTarget(), 0, &hotKey)
        if result != noErr {
            let item = NSMenuItem(title: "⌘⇧Пробел занят — используйте меню «Новая запись»", action: nil, keyEquivalent: "")
            statusItem.menu?.insertItem(item, at: 0)
        }
    }

    @objc func showWindow(_ sender: Any?) {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc func quickCapture(_ sender: Any?) {
        pendingDestination = nil; capturePending = true; showWindow(nil)
        if let current = webView.url, DesktopOrigin.contains(current, origin: origin), !webView.isLoading {
            beginCaptureFocus()
        } else if !webView.isLoading { webView.load(URLRequest(url: origin)) }
    }
    private func openNotification(_ url: URL) {
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
        errorView.isHidden = true
        let url = webView.url.flatMap { DesktopOrigin.contains($0, origin: origin) ? $0 : nil } ?? origin
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }
    @objc private func openInBrowser(_ sender: Any?) {
        let url = webView.url.flatMap { DesktopOrigin.contains($0, origin: origin) ? $0 : nil } ?? origin
        NSWorkspace.shared.open(url)
    }
    @objc private func enableNotifications(_ sender: Any?) { notifications.requestAuthorization() }
    @objc private func about(_ sender: Any?) {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "Кизуна", .credits: NSAttributedString(string:
            "⌘⇧Пробел — новая запись из любого приложения.\nУведомления приходят, пока Кизуна запущена.\nДля работы требуется интернет.")])
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) {
        notifications?.stop()
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
    }
}
