import AppKit
import WebKit

private final class CaptureTransport: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private final class CapturePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private final class CaptureEditor: NSTextView {
    var onSubmit: (() -> Void)?
    var onDismiss: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if !hasMarkedText() {
            if event.keyCode == 53 { onDismiss?(); return }
            if [36, 76].contains(event.keyCode), !event.modifierFlags.contains(.shift) { onSubmit?(); return }
        }
        super.keyDown(with: event)
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if !hasMarkedText(), [36, 76].contains(event.keyCode), event.modifierFlags.contains(.command) {
            onSubmit?(); return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

enum QuickCapturePolicy {
    static func validText(_ text: String) -> Bool { !text.isEmpty && text.utf16.count <= 10_000 }
    static func confirmed(_ data: [String: Any], origin: URL) -> Bool {
        guard let captureID = data["captureId"] as? String, UUID(uuidString: captureID) != nil,
              let jobID = data["jobId"] as? String, UUID(uuidString: jobID) != nil,
              let path = data["statusUrl"] as? String,
              let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              DesktopOrigin.contains(url, origin: origin), url.query == nil, url.fragment == nil,
              url.path == "/api/jobs/\(jobID)" else { return false }
        return true
    }
    static func selfTest() {
        func check(_ value: Bool) { if !value { fputs("FAIL: quick capture policy\n", stderr); exit(1) } }
        check(!validText("")); check(validText(String(repeating: "a", count: 10_000)))
        check(!validText(String(repeating: "🙂", count: 5_001)))
        let id = "00000000-0000-4000-8000-000000000001"
        let envelope: [String: Any] = ["captureId": id, "jobId": id, "statusUrl": "/api/jobs/\(id)"]
        check(confirmed(envelope, origin: DesktopOrigin.production))
        var hostile = envelope; hostile["statusUrl"] = "https://example.com/api/jobs/\(id)"
        check(!confirmed(hostile, origin: DesktopOrigin.production))
        hostile = envelope; hostile["jobId"] = "wrong"
        check(!confirmed(hostile, origin: DesktopOrigin.production))
        print("PASS: quick capture policy (6 checks)")
    }
}

@MainActor
final class DesktopQuickCapture: NSObject, NSWindowDelegate, NSTextViewDelegate {
    private weak var webView: WKWebView?
    private let origin: URL
    private let panel: CapturePanel
    private let editor = CaptureEditor()
    private let message = NSTextField(wrappingLabelWithString: "Enter — сохранить · Shift+Enter — новая строка · Esc — позже")
    private let submitButton = NSButton(title: "Сохранить ↵", target: nil, action: nil)
    private let transport = CaptureTransport()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 30
        return URLSession(configuration: configuration, delegate: transport, delegateQueue: nil)
    }()
    private struct Attempt {
        let raw: String
        let key: String
        let account: String
        let body: Data
    }
    private var attempt: Attempt?
    private var busy = false
    private var unconfirmed = false
    private var awaitingLogin = false
    private var previousApp: NSRunningApplication?
    var onLogin: (() -> Void)?

    init(webView: WKWebView, origin: URL) {
        self.webView = webView; self.origin = origin
        panel = CapturePanel(contentRect: NSRect(x: 0, y: 0, width: 600, height: 252),
                             styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "Быстрая запись — Кизуна"; panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true; panel.isFloatingPanel = true; panel.level = .floating
        panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.delegate = self; panel.isMovableByWindowBackground = true
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(button)?.isHidden = true }
        let base = NSVisualEffectView(); base.material = .popover; base.state = .active
        panel.contentView = base
        let title = NSTextField(labelWithString: "Что нужно запомнить?"); title.font = .systemFont(ofSize: 15, weight: .semibold)
        let close = NSButton(title: "×", target: self, action: #selector(dismissAction))
        close.bezelStyle = .inline; close.setAccessibilityLabel("Скрыть, сохранив черновик")
        let top = NSStackView(views: [title, NSView(), close]); top.orientation = .horizontal
        editor.isRichText = false; editor.font = .systemFont(ofSize: 20); editor.backgroundColor = .clear
        editor.drawsBackground = false; editor.textColor = .labelColor; editor.insertionPointColor = .labelColor
        editor.textContainerInset = NSSize(width: 0, height: 10)
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]; editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: 540, height: CGFloat.greatestFiniteMagnitude)
        editor.allowsUndo = true; editor.delegate = self; editor.setAccessibilityLabel("Новая запись")
        editor.onSubmit = { [weak self] in self?.submit() }
        editor.onDismiss = { [weak self] in self?.hide(restoreFocus: true) }
        let scroll = NSScrollView(); scroll.drawsBackground = false; scroll.hasVerticalScroller = true
        scroll.documentView = editor; editor.frame = NSRect(x: 0, y: 0, width: 544, height: 114)
        message.font = .systemFont(ofSize: 11); message.textColor = .secondaryLabelColor
        submitButton.bezelStyle = .rounded; submitButton.target = self; submitButton.action = #selector(submitAction)
        submitButton.isEnabled = false
        let bottom = NSStackView(views: [message, submitButton]); bottom.orientation = .horizontal; bottom.spacing = 16
        let stack = NSStackView(views: [top, scroll, bottom]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false; base.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: base.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: base.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: base.topAnchor, constant: 20), stack.bottomAnchor.constraint(equalTo: base.bottomAnchor, constant: -20),
            top.widthAnchor.constraint(equalTo: stack.widthAnchor), scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            bottom.widthAnchor.constraint(equalTo: stack.widthAnchor), scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 90)
        ])
        message.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        submitButton.setContentCompressionResistancePriority(.required, for: .horizontal)
    }

    func show() {
        if panel.isVisible { panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(editor); return }
        previousApp = NSWorkspace.shared.frontmostApplication
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        if let frame = screen?.visibleFrame {
            let width = min(600, frame.width - 40)
            panel.setFrame(NSRect(x: frame.midX - width / 2, y: frame.minY + frame.height * 0.63 - 126, width: width, height: 252), display: true)
        }
        panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
    }
    func resumeAfterLogin() {
        guard awaitingLogin else { return }
        awaitingLogin = false
        message.stringValue = "Вход выполнен. Нажмите Enter, чтобы сохранить черновик."
        show()
    }
    private func hide(restoreFocus: Bool) {
        let wasVisible = panel.isVisible
        panel.orderOut(nil)
        if restoreFocus && wasVisible, let previousApp, !previousApp.isTerminated { previousApp.activate(options: []) }
    }
    func windowDidResignKey(_ notification: Notification) { hide(restoreFocus: false) }
    @objc private func dismissAction() { hide(restoreFocus: true) }
    @objc private func submitAction() { submit() }
    func textDidChange(_ notification: Notification) {
        let raw = editor.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty && !unconfirmed { attempt = nil }
        submitButton.isEnabled = !busy && QuickCapturePolicy.validText(raw)
        if !QuickCapturePolicy.validText(raw) && !raw.isEmpty { message.stringValue = "В записи может быть не больше 10 000 символов." }
    }
    private func setBusy(_ value: Bool) {
        busy = value; editor.isEditable = !value && !unconfirmed
        submitButton.isEnabled = !value && QuickCapturePolicy.validText(editor.string.trimmingCharacters(in: .whitespacesAndNewlines))
        submitButton.title = value ? "Сохраняем…" : "Сохранить ↵"
    }
    private enum CaptureError: Error { case login, changedAccount, message(String) }
    private func cookieHeader() async throws -> String {
        guard let webView else { throw CaptureError.login }
        let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        let selected = cookies.filter {
            $0.name == "pagent_session" && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == origin.host?.lowercased()
            && $0.path == "/" && (!$0.isSecure || origin.scheme == "https")
            && ($0.expiresDate == nil || $0.expiresDate! > Date())
        }
        guard !selected.isEmpty, let header = HTTPCookie.requestHeaderFields(with: selected)["Cookie"] else { throw CaptureError.login }
        return header
    }
    private func request(_ path: String, cookie: String, attempt: Attempt? = nil) async throws -> (Int, [String: Any]) {
        let url = URL(string: path, relativeTo: origin)!.absoluteURL
        var request = URLRequest(url: url); request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let attempt {
            request.httpMethod = "POST"; request.httpBody = attempt.body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("respond-async", forHTTPHeaderField: "Prefer")
            request.setValue(attempt.key, forHTTPHeaderField: "Idempotency-Key")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, let final = response.url,
              DesktopOrigin.contains(final, origin: origin), data.count <= 1_048_576 else { throw CaptureError.message("Не удалось проверить ответ сервера. Черновик сохранён.") }
        if response.statusCode == 401 { throw CaptureError.login }
        guard let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CaptureError.message("Сервер не подтвердил сохранение. Повторите отправку.") }
        return (response.statusCode, payload)
    }
    private func submit() {
        let raw = editor.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, QuickCapturePolicy.validText(raw) else { return }
        guard !unconfirmed || attempt?.raw == raw else {
            message.stringValue = "Сначала нужно подтвердить прежнюю отправку. Верните исходный текст для безопасного повтора."
            return
        }
        setBusy(true); message.stringValue = "Сохраняем запись…"
        Task { [weak self] in
            guard let self else { return }
            let previouslyUnconfirmed = self.unconfirmed
            defer { self.setBusy(false) }
            do {
                let cookie = try await self.cookieHeader()
                let (meStatus, me) = try await self.request("/api/auth/me", cookie: cookie)
                guard meStatus == 200, let account = (me["user"] as? [String: Any])?["id"] as? String else { throw CaptureError.login }
                if let previous = self.attempt, previous.account != account { throw CaptureError.changedAccount }
                if self.attempt?.raw != raw {
                    var body: [String: Any] = ["raw": raw]
                    if let webView = self.webView, let url = webView.url, DesktopOrigin.contains(url, origin: self.origin),
                       let selected = try? await webView.evaluateJavaScript("""
                       (() => {
                         const provider = document.querySelector('#ai-provider');
                         const model = document.querySelector('#ai-model');
                         const result = {};
                         if (provider?.options.length) {
                           result.provider = provider.value || 'fallback';
                           if (['openrouter','openai','gemini'].includes(result.provider) && model?.value) result.model = model.value;
                         }
                         return result;
                       })()
                       """), let options = selected as? [String: String] {
                        for key in ["provider", "model"] { if let value = options[key] { body[key] = value } }
                    }
                    self.attempt = Attempt(raw: raw, key: "mac-\(UUID().uuidString)", account: account, body: try JSONSerialization.data(withJSONObject: body))
                }
                guard let pending = self.attempt else { return }
                // Never send a draft after the session in the web view changes.
                guard try await self.cookieHeader() == cookie else { throw CaptureError.changedAccount }
                self.unconfirmed = true
                let (status, payload) = try await self.request("/api/captures", cookie: cookie, attempt: pending)
                if !previouslyUnconfirmed && (400..<500).contains(status) && status != 409 { self.unconfirmed = false }
                guard status == 202, QuickCapturePolicy.confirmed(payload, origin: self.origin) else {
                    let detail = (payload["error"] as? [String: Any])?["message"] as? String
                    throw CaptureError.message(detail ?? "Сервер не подтвердил сохранение. Черновик остался здесь.")
                }
                self.editor.string = ""; self.editor.undoManager?.removeAllActions(); self.attempt = nil
                self.unconfirmed = false
                self.message.stringValue = "Enter — сохранить · Shift+Enter — новая строка · Esc — позже"
                self.hide(restoreFocus: true)
            } catch CaptureError.login {
                self.awaitingLogin = true; self.message.stringValue = "Войдите в Кизуну. Черновик останется здесь."
                self.hide(restoreFocus: false); self.onLogin?()
            } catch CaptureError.changedAccount {
                self.message.stringValue = "Учётная запись изменилась. Вернитесь в прежнюю учётную запись для отправки этого черновика."
            } catch CaptureError.message(let message) {
                self.message.stringValue = message
            } catch {
                self.message.stringValue = self.unconfirmed
                    ? "Нет подтверждения. Текст защищён от изменений: нажмите Enter для безопасного повтора."
                    : "Нет связи с сервером. Черновик сохранён — попробуйте ещё раз."
            }
        }
    }
}
